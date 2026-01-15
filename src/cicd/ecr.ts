import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { currentStack, ResourceArgs } from '../types'

export interface EcrRepoConfig {
	appId: string
	includeTasksRepo: boolean
}

export interface EcrRepositories {
	main: aws.ecr.Repository
	tasks?: aws.ecr.Repository
	mainRepoUrl: pulumi.Output<string>
	tasksRepoUrl?: pulumi.Output<string>
}

export function createAppEcrRepositories(args: ResourceArgs<EcrRepoConfig>): EcrRepositories {
	const mainRepo = new aws.ecr.Repository(`${args.appId}-main-ecr`, {
		name: `${currentStack}/${args.appId}/main`,
		imageTagMutability: 'MUTABLE',
		imageScanningConfiguration: {
			scanOnPush: true
		},
		forceDelete: currentStack !== 'production',
		tags: {
			Name: `${args.appId} Main Image Repository`,
			stack: currentStack,
			app: args.appId
		}
	})

	new aws.ecr.LifecyclePolicy(`${args.appId}-main-lifecycle`, {
		repository: mainRepo.name,
		policy: JSON.stringify({
			rules: [{
				rulePriority: 1,
				description: 'Keep last 10 images',
				selection: {
					tagStatus: 'any',
					countType: 'imageCountMoreThan',
					countNumber: 10
				},
				action: { type: 'expire' }
			}]
		})
	})

	let tasksRepo: aws.ecr.Repository | undefined
	let tasksRepoUrl: pulumi.Output<string> | undefined

	if (args.includeTasksRepo) {
		tasksRepo = new aws.ecr.Repository(`${args.appId}-tasks-ecr`, {
			name: `${currentStack}/${args.appId}/tasks`,
			imageTagMutability: 'MUTABLE',
			imageScanningConfiguration: { scanOnPush: true },
			forceDelete: currentStack !== 'production',
			tags: {
				Name: `${args.appId} Tasks Image Repository`,
				stack: currentStack,
				app: args.appId
			}
		})

		new aws.ecr.LifecyclePolicy(`${args.appId}-tasks-lifecycle`, {
			repository: tasksRepo.name,
			policy: JSON.stringify({
				rules: [{
					rulePriority: 1,
					description: 'Keep last 10 images',
					selection: {
						tagStatus: 'any',
						countType: 'imageCountMoreThan',
						countNumber: 10
					},
					action: { type: 'expire' }
				}]
			})
		})

		tasksRepoUrl = tasksRepo.repositoryUrl
	}

	return {
		main: mainRepo,
		tasks: tasksRepo,
		mainRepoUrl: mainRepo.repositoryUrl,
		tasksRepoUrl
	}
}
