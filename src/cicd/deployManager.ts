import { Cluster } from "../cluster"
import { currentStack, isLocalStack, Repository, ResourceArgs } from "../types"
import { createDeploymentManagerInCluster, createManagerEcrRepository } from "./manager"
import { createDeploymentQueue } from "./sqs"
import { createCodeBuildRole, createManagerCodeBuildRole, createManagerPodRole } from "./iam"

import * as pulumi from '@pulumi/pulumi'

import { BunApp } from "../app"
import { BunAppConfig, getSecretArn, NativeSecretEnvEntry } from "../app/types"
import { createCodeBuildProject, createManagerCodeBuildProject } from "./codebuild"
import { EcrRepositories } from "./ecr"

export interface DeploymentManager {
	createBunAppDeployPipeline(app: BunApp, args: ResourceArgs<BunAppConfig>, ecrRepos: EcrRepositories): void
}

export class LocalDeploymentManager implements DeploymentManager {
	createBunAppDeployPipeline(app: BunApp, args: ResourceArgs<BunAppConfig>, ecrRepos: EcrRepositories): void {
		throw new Error("Local deployment manager is not implemented")
	}
}

export class AWSDeploymentManager implements DeploymentManager {
	private readonly sqsQueueArn: pulumi.Input<string>
	private readonly sqsQueueUrl: pulumi.Input<string>

	constructor(sqsQueueArn: pulumi.Input<string>, sqsQueueUrl: pulumi.Input<string>) {
		this.sqsQueueArn = sqsQueueArn
		this.sqsQueueUrl = sqsQueueUrl
	}

    createBunAppDeployPipeline(app: BunApp, args: ResourceArgs<BunAppConfig>, repos: EcrRepositories): void {
		let publicEnvs = args.env
			.filter((e) => e.isPublic === true)

		// TODO: we should really rename `isPublic` to something that more closely communicates that it means it's available in CodeBuild and not public-public (e.g., the below)
		publicEnvs.push({ name: "DOCKER_USERNAME", value: { type: 'secret-arn', secretName: "docker/auth", key: 'user' }, isPublic: true })
		publicEnvs.push({ name: "DOCKER_PASSWORD", value: { type: 'secret-arn', secretName: "docker/auth", key: 'password' }, isPublic: true })

		const codeBuildRole = createCodeBuildRole({
			id: `${args.id}-cb-role`,
			appId: args.id,
			ecrMainRepoArn: repos.main.arn,
			ecrTasksRepoArn: repos.tasks?.arn,
			sqsQueueArn: this.sqsQueueArn,
			region: args.region,
			secretArns: publicEnvs
				.filter((e) => typeof e.value == 'object' && e.value.type == 'secret-arn')
				.map((e) => getSecretArn((e.value as NativeSecretEnvEntry).secretName, args.region))
		})
	
		createCodeBuildProject({
			id: `${args.id}-codebuild`,
			appId: args.id,
			repository: args.repository,
			runtime: args.runtime,
			hasTasks: app.tasks.length > 0,
			serviceRole: codeBuildRole,
			ecrMainRepoUrl: repos.mainRepoUrl,
			ecrTasksRepoUrl: repos.tasksRepoUrl,
			sqsQueueUrl: this.sqsQueueUrl,
			taskCronJobIds: app.taskNames,
			npmrc: args.npmrc,
			region: args.region,
			env: publicEnvs,
			branch: args.branch
		})
    }
}

interface DeploymentManagerConfig {
	cluster: Cluster
	managerRepository: Repository
	managerBranch: string
}

export function createDeploymentManager(args: ResourceArgs<DeploymentManagerConfig>): DeploymentManager {
	if (isLocalStack(currentStack)) return new LocalDeploymentManager()

	const managerEcr = createManagerEcrRepository({
		id: `${args.id}-manager-ecr`,
		region: args.region
	})

	const deploymentQueue = createDeploymentQueue({
		id: `${args.id}-queue`,
		region: args.region,
		visibilityTimeoutSeconds: 900  // 15 minutes for task execution
	})		

	const managerRole = createManagerPodRole({
		id: `${args.id}-manager-role`,
		region: args.region,
		oidcProviderArn: args.cluster.backing('prod').cluster.oidcProviderArn!,
		oidcProviderUrl: args.cluster.backing('prod').cluster.oidcProviderUrl!,
		sqsQueueArn: deploymentQueue.queueArn,
		namespace: 'default',
		serviceAccountName: 'cicd-manager'
	})

	const manager = createDeploymentManagerInCluster({
		id: `${args.id}-manager`,
		region: args.region,
		cluster: args.cluster,
		sqsQueueUrl: deploymentQueue.queueUrl,
		iamRoleArn: managerRole.arn,
		managerImageUrl: managerEcr.repositoryUrl.apply(url => `${url}:latest`),
		namespace: 'default',
		taskTimeoutMs: 600000  // 10 minutes for tasks
	})

	// CodeBuild project for manager self-deployment
	const managerCodeBuildRole = createManagerCodeBuildRole({
		id: `${args.id}-manager-cb-role`,
		region: args.region,
		ecrRepoArn: managerEcr.repository.arn,
		sqsQueueArn: deploymentQueue.queueArn
	})

	createManagerCodeBuildProject({
		id: `${args.id}-manager-cb`,
		region: args.region,
		repository: args.managerRepository,
		branch: args.managerBranch,
		serviceRole: managerCodeBuildRole,
		ecrRepoUrl: managerEcr.repositoryUrl,
		sqsQueueUrl: deploymentQueue.queueUrl
	})

	return new AWSDeploymentManager(deploymentQueue.queueArn, deploymentQueue.queueUrl)
}