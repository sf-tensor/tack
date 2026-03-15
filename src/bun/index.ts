import * as aws from '@pulumi/aws'
import * as k8s from '@pulumi/kubernetes'
import * as pulumi from '@pulumi/pulumi'

import { BunAppConfig, BunAppOutputs } from './types'
import { currentStack, isLocalStack, Resource, ResourceArgs } from '../types'

import { createBunDevelopmentApp } from './development'
import { createBunLocalStagingApp } from './local-staging'
import { createBunProductionApp } from './production'
import { Bucket } from '../bucket'

export { generateNpmRc } from './util'
export type { DevPodConfig, BunAppConfig, BunContainerConfig, EnvEntry } from './types'

export class Role extends Resource<{ role: aws.iam.Role }, {}> {
	protected policyCounter = 0

	constructor(backing: { role: aws.iam.Role } | {}) {
		super(backing)
	}

	public arn(): pulumi.Output<string> {
		if (isLocalStack(this.stack)) throw new Error('arb is not available for local stacks')
		return this.backing('prod').role.arn
	}

	public role(): aws.iam.Role {
		if (isLocalStack(this.stack)) throw new Error('arb is not available for local stacks')
		return this.backing('prod').role
	}

	public attachPolicy(name: string, statements: aws.iam.PolicyStatement[]): void {
		if (isLocalStack(this.stack)) return

		const policyName = `${name}-${this.policyCounter++}`

		new aws.iam.RolePolicy(policyName, {
			role: this.backing('prod').role.name,
			policy: pulumi.output(statements).apply(stmts => JSON.stringify({
				Version: "2012-10-17",
				Statement: stmts
			}))
		})
	}

	public grantBucketAccess(buckets: Bucket[], access: 'read-only' | 'read-write'): void {
		if (isLocalStack(this.stack)) return

		const bucketArns = buckets.map(b => b.backing('prod').bucket.arn)
		const objectArns = buckets.map(b => pulumi.interpolate`${b.backing('prod').bucket.arn}/*`)

		const statements: aws.iam.PolicyStatement[] = [
			{
				Effect: 'Allow',
				Action: ['s3:ListBucket'],
				Resource: bucketArns
			},
			{
				Effect: 'Allow',
				Action: access === 'read-only'
					? ['s3:GetObject']
					: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
				Resource: objectArns
			}
		]

		this.attachPolicy('bucket-access', statements)
	}
}

export class BunApp extends Resource<{}> {
	public readonly service: k8s.core.v1.Service
	public readonly services: Record<string, k8s.core.v1.Service>
	public readonly taskNames: string[]
	public readonly tasks: (k8s.batch.v1.Job | k8s.batch.v1.CronJob)[]
	public readonly deployment: k8s.apps.v1.Deployment
	public readonly deployments: Record<string, k8s.apps.v1.Deployment>
	public readonly role: Role

	constructor(outputs: BunAppOutputs, backing: {}) {
		super(backing)

		this.tasks = outputs.tasks
		this.service = outputs.service
		this.services = outputs.services ?? { application: outputs.service }
		this.taskNames = outputs.taskNames
		this.deployment = outputs.deployment
		this.deployments = outputs.deployments ?? { application: outputs.deployment }
		this.role = outputs.iamRole
			? new Role({ role: outputs.iamRole })
			: new Role({})
	}
}

export function createBunApp(args: ResourceArgs<BunAppConfig>): BunApp {
	if (currentStack === 'development') return createBunDevelopmentApp(args)
	if (currentStack === 'local-staging') return createBunLocalStagingApp(args)

	return createBunProductionApp(args)
}
