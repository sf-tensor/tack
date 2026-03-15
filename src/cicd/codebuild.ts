import * as aws from '@pulumi/aws'
import * as command from '@pulumi/command'
import * as pulumi from '@pulumi/pulumi'
import * as fs from 'fs'
import * as path from 'path'
import { currentStack, githubConnectorArn, ResourceArgs, Repository } from '../types'
import { EnvEntry } from '../bun/types'

function getDockerfileContent(filename: string): string {
	const dockerfilePath = path.join(__dirname, '../bun/assets', filename)
	return fs.readFileSync(dockerfilePath, 'utf-8')
}

export interface CodeBuildProjectConfig {
	appId: string
	repository: Repository
	runtime: 'next' | 'base'
	hasTasks: boolean
	buildTask: string
	serviceRole: aws.iam.Role
	ecrMainRepoUrl: pulumi.Input<string>
	ecrTasksRepoUrl?: pulumi.Input<string>
	sqsQueueUrl: pulumi.Input<string>
	taskCronJobIds: string[]  // CronJob names for tasks
	buildTimeout?: number  // minutes, default 20
	npmrc?: string  // .npmrc content for private package authentication
	branch: string
	env: EnvEntry[]
}

export function createCodeBuildProject(args: ResourceArgs<CodeBuildProjectConfig>): aws.codebuild.Project {
	const sourceLocation = `https://github.com/${args.repository.org}/${args.repository.repo}.git`
	const dockerfileName = args.runtime === 'next' ? 'Dockerfile.next' : 'Dockerfile.base'
	const dockerfileMain = getDockerfileContent(dockerfileName)
	const dockerfileTasks = args.hasTasks ? getDockerfileContent('Dockerfile.tasks') : undefined

	const project = new aws.codebuild.Project(`${args.appId}-codebuild`, {
		name: `${currentStack}-${args.appId}`,
		description: `Build project for ${args.appId} in ${currentStack}`,
		buildTimeout: args.buildTimeout ?? 20,
		serviceRole: args.serviceRole.arn,
		sourceVersion: args.branch,

		source: {
			type: 'GITHUB',
			location: sourceLocation,
			gitCloneDepth: 1,
			buildspec: generateBuildspec({
				appId: args.appId,
				runtime: args.runtime,
				hasTasks: args.hasTasks,
				taskCronJobIds: args.taskCronJobIds,
				dockerfileMain,
				dockerfileTasks,
				envVariables: args.env.map((e) => e.name)
			})
		},

		environment: {
			computeType: 'BUILD_GENERAL1_LARGE',
			image: 'aws/codebuild/amazonlinux2-aarch64-standard:3.0',
			type: 'ARM_CONTAINER',
			privilegedMode: true,  // Required for Docker builds
			environmentVariables: [
				...args.env.map((e) => {
					if (typeof e.value == 'object') {
						if (e.value.type == 'secret') throw new Error("Can't access Kubernetes Secret in Codebuild")
						if (e.value.type == 'value') return { name: e.name, value: e.value.value }
						if (e.value.type == 'secret-arn') {
							if (e.value.key != undefined) return { name: e.name, value: `${e.value.secretName}:${e.value.key}`, type: 'SECRETS_MANAGER' }
							return { name: e.name, value: e.value.secretName, type: 'SECRETS_MANAGER' }
						}
					}

					return { name: e.name, value: e.value }
				}),
				{ name: 'APP_ID', value: args.appId },
				{ name: 'STACK', value: currentStack },
				{ name: 'RUNTIME', value: args.runtime },
				{ name: 'DOCKERFILE', value: dockerfileName },
				{ name: 'HAS_TASKS', value: args.hasTasks ? 'true' : 'false' },
				{ name: 'BUILD_TASK', value: args.buildTask },
				{ name: 'TASK_CRONJOB_IDS', value: args.taskCronJobIds.join(',') },
				{
					name: 'ECR_MAIN_REPO',
					value: pulumi.output(args.ecrMainRepoUrl).apply(v => v)
				},
				{
					name: 'ECR_TASKS_REPO',
					value: args.ecrTasksRepoUrl
						? pulumi.output(args.ecrTasksRepoUrl).apply(v => v)
						: ''
				},
				{
					name: 'SQS_QUEUE_URL',
					value: pulumi.output(args.sqsQueueUrl).apply(v => v)
				},
				...(args.npmrc ? [{ name: 'NPMRC', value: args.npmrc }] : []),
			]
		},

		artifacts: {
			type: 'NO_ARTIFACTS'
		},

		cache: {
			type: 'LOCAL',
			modes: ['LOCAL_DOCKER_LAYER_CACHE', 'LOCAL_SOURCE_CACHE']
		},

		logsConfig: {
			cloudwatchLogs: {
				groupName: `/codebuild/${currentStack}/${args.appId}`,
				streamName: 'build-logs'
			}
		},

		tags: {
			Name: `${args.appId} CodeBuild Project`,
			stack: currentStack,
			app: args.appId
		}
	})

	new aws.codebuild.Webhook(`${args.appId}-webhook`, {
		projectName: project.name,
		buildType: 'BUILD',
		filterGroups: [{
			filters: [
				{
					type: 'EVENT',
					pattern: 'PUSH'
				},
				{
					type: 'HEAD_REF',
					pattern: `^refs/heads/${args.branch}$`
				}
			]
		}]
	})

	// Trigger initial build on project creation/update
	new command.local.Command(`${args.appId}-build-trigger`, {
		create: pulumi.interpolate`aws codebuild start-build --project-name ${project.name} > /dev/null 2>&1 || true`,
		update: pulumi.interpolate`aws codebuild start-build --project-name ${project.name} > /dev/null 2>&1 || true`,
		triggers: [project]
	}, { dependsOn: [project] })
	return project
}

interface BuildspecConfig {
	appId: string
	runtime: 'next' | 'base'
	hasTasks: boolean
	taskCronJobIds: string[]
	dockerfileMain: string
	dockerfileTasks?: string
	envVariables: string[]
}

function generateBuildspec(config: BuildspecConfig): string {
	const mainDockerfileBase64 = Buffer.from(config.dockerfileMain).toString('base64')
	const tasksDockerfileBase64 = config.dockerfileTasks
		? Buffer.from(config.dockerfileTasks).toString('base64')
		: ''

	const dockerfileTasksCommand = config.dockerfileTasks
		? `
      - echo "${tasksDockerfileBase64}" | base64 -d > Dockerfile.tasks`
		: ''

	const envVariables = [...config.envVariables]
	envVariables.push('COMMIT_HASH')
	envVariables.push('DEPLOYMENT_ID')
	envVariables.push('STACK')

	return `version: 0.2

env:
  variables:
    DOCKER_BUILDKIT: "1"

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $(echo $ECR_MAIN_REPO | cut -d'/' -f1)
      - echo "$DOCKER_PASSWORD" | docker login -u "$DOCKER_USERNAME" --password-stdin
      - echo Creating Dockerfile from infrastructure config...
      - echo "${mainDockerfileBase64}" | base64 -d > $DOCKERFILE${dockerfileTasksCommand}
      - |
        if [ -n "$NPMRC" ]; then
          echo "Creating .npmrc for private package authentication..."
          echo "$NPMRC" > .npmrc
        fi
      - COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)
      - IMAGE_TAG=\${COMMIT_HASH:-latest}-\${CODEBUILD_BUILD_NUMBER}
      - DEPLOYMENT_ID="$APP_ID-$IMAGE_TAG-$(date +%s)"

  build:
    commands:
      - echo Build started on \`date\`
      - echo -e "${envVariables.map((v) => `${v}=\\"$${v}\\"`).join('\\n')}" > .env

      - echo Building main image with $DOCKERFILE...
      - |
        if [ -f .npmrc ]; then
          docker build -f $DOCKERFILE --build-arg BUILD_TASK="$BUILD_TASK" --secret id=env,src=.env --secret id=npmrc,src=.npmrc -t $ECR_MAIN_REPO:$IMAGE_TAG -t $ECR_MAIN_REPO:latest .
        else
          docker build -f $DOCKERFILE --build-arg BUILD_TASK="$BUILD_TASK" --secret id=env,src=.env -t $ECR_MAIN_REPO:$IMAGE_TAG -t $ECR_MAIN_REPO:latest .
        fi

      - |
        if [ "$HAS_TASKS" = "true" ] && [ -n "$ECR_TASKS_REPO" ]; then
          echo Building tasks image...
          if [ -f .npmrc ]; then
            docker build -f Dockerfile.tasks --secret id=npmrc,src=.npmrc -t $ECR_TASKS_REPO:$IMAGE_TAG -t $ECR_TASKS_REPO:latest .
          else
            docker build -f Dockerfile.tasks -t $ECR_TASKS_REPO:$IMAGE_TAG -t $ECR_TASKS_REPO:latest .
          fi
        fi

  post_build:
    commands:
      - echo Build completed on \`date\`
      - echo Pushing images to ECR...
      - docker push $ECR_MAIN_REPO:$IMAGE_TAG
      - docker push $ECR_MAIN_REPO:latest

      - |
        if [ "$HAS_TASKS" = "true" ] && [ -n "$ECR_TASKS_REPO" ]; then
          docker push $ECR_TASKS_REPO:$IMAGE_TAG
          docker push $ECR_TASKS_REPO:latest
        fi

      - echo Sending deployment message to SQS...
      - |
        TASKS_IMAGE=""
        if [ "$HAS_TASKS" = "true" ] && [ -n "$ECR_TASKS_REPO" ]; then
          TASKS_IMAGE="$ECR_TASKS_REPO:$IMAGE_TAG"
        fi

        MESSAGE=$(jq -n \\
          --arg deploymentId "$DEPLOYMENT_ID" \\
          --arg appId "$APP_ID" \\
          --arg deploymentImage "$ECR_MAIN_REPO:$IMAGE_TAG" \\
          --arg tasksImage "$TASKS_IMAGE" \\
          --arg taskCronJobIds "$TASK_CRONJOB_IDS" \\
          --arg commitHash "$COMMIT_HASH" \\
          --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
          '{
            deploymentId: $deploymentId,
            appId: $appId,
            deploymentImage: $deploymentImage,
            tasksImage: $tasksImage,
            taskCronJobIds: $taskCronJobIds,
            commitHash: $commitHash,
            timestamp: $timestamp
          }')

        aws sqs send-message \\
          --queue-url "$SQS_QUEUE_URL" \\
          --message-body "$MESSAGE"

      - echo Deployment message sent to SQS
`
}

// ============================================
// Manager CodeBuild Project
// ============================================
export interface ManagerCodeBuildConfig {
	repository: Repository
	branch?: string
	serviceRole: aws.iam.Role
	ecrRepoUrl: pulumi.Input<string>
	sqsQueueUrl: pulumi.Input<string>
}

export function createManagerCodeBuildProject(args: ResourceArgs<ManagerCodeBuildConfig>): aws.codebuild.Project {
	const sourceLocation = `https://github.com/${args.repository.org}/${args.repository.repo}.git`
	const sourceBranch = args.branch ?? 'master'

	const project = new aws.codebuild.Project(`cicd-manager-codebuild`, {
		name: `${currentStack}-cicd-manager`,
		description: `Build project for CI/CD Manager in ${currentStack}`,
		buildTimeout: 15,
		serviceRole: args.serviceRole.arn,
		sourceVersion: sourceBranch,

		source: {
			type: 'GITHUB',
			location: sourceLocation,
			gitCloneDepth: 1,
			buildspec: generateManagerBuildspec()
		},

		environment: {
			computeType: 'BUILD_GENERAL1_LARGE',
			image: 'aws/codebuild/amazonlinux2-aarch64-standard:3.0',
			type: 'ARM_CONTAINER',
			privilegedMode: true,
			environmentVariables: [
				{
					name: 'ECR_REPO',
					value: pulumi.output(args.ecrRepoUrl).apply(v => v)
				},
				{
					name: 'SQS_QUEUE_URL',
					value: pulumi.output(args.sqsQueueUrl).apply(v => v)
				}
			]
		},

		artifacts: {
			type: 'NO_ARTIFACTS'
		},

		cache: {
			type: 'LOCAL',
			modes: ['LOCAL_DOCKER_LAYER_CACHE', 'LOCAL_SOURCE_CACHE']
		},

		logsConfig: {
			cloudwatchLogs: {
				groupName: `/codebuild/${currentStack}/cicd-manager`,
				streamName: 'build-logs'
			}
		},

		tags: {
			Name: 'CI/CD Manager CodeBuild Project',
			stack: currentStack,
			app: 'cicd-manager'
		}
	})

	new aws.codebuild.Webhook(`cicd-manager-webhook`, {
		projectName: project.name,
		buildType: 'BUILD',
		filterGroups: [{
			filters: [
				{
					type: 'EVENT',
					pattern: 'PUSH'
				},
				{
					type: 'HEAD_REF',
					pattern: `^refs/heads/${sourceBranch}$`
				}
			]
		}]
	})

	// Trigger initial build on project creation/update
	new command.local.Command(`cicd-manager-build-trigger`, {
		create: pulumi.interpolate`aws codebuild start-build --project-name ${project.name} > /dev/null 2>&1 || true`,
		triggers: [project.id],
	}, { dependsOn: [project] })

	return project
}

function generateManagerBuildspec(): string {
	return `version: 0.2

env:
  variables:
    DOCKER_BUILDKIT: "1"

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $(echo $ECR_REPO | cut -d'/' -f1)
      - COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)
      - IMAGE_TAG=\${COMMIT_HASH:-latest}-\${CODEBUILD_BUILD_NUMBER}

  build:
    commands:
      - echo Build started on \\\`date\\\`
      - echo Building manager image...
      - docker build -t $ECR_REPO:$IMAGE_TAG -t $ECR_REPO:latest .

  post_build:
    commands:
      - echo Build completed on \\\`date\\\`
      - echo Pushing images to ECR...
      - docker push $ECR_REPO:$IMAGE_TAG
      - docker push $ECR_REPO:latest

      - echo Sending deployment message to SQS...
      - |
        MESSAGE=$(jq -n \\
          --arg deploymentId "cicd-manager-$IMAGE_TAG-$(date +%s)" \\
          --arg appId "cicd-manager" \\
          --arg deploymentImage "$ECR_REPO:$IMAGE_TAG" \\
          --arg tasksImage "" \\
          --arg taskCronJobIds "" \\
          --arg commitHash "$COMMIT_HASH" \\
          --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
          '{
            deploymentId: $deploymentId,
            appId: $appId,
            deploymentImage: $deploymentImage,
            tasksImage: $tasksImage,
            taskCronJobIds: $taskCronJobIds,
            commitHash: $commitHash,
            timestamp: $timestamp
          }')

        aws sqs send-message \\
          --queue-url "$SQS_QUEUE_URL" \\
          --message-body "$MESSAGE"

      - echo Deployment message sent to SQS
`
}
