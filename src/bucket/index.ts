import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { createMinioBucket } from './local'
import { addS3LifecycleRules, createS3Bucket } from './aws'
import { BucketConfig, BucketOutputs, LifecycleRule } from './types'

import { currentStack, isLocalStack, Resource, ResourceArgs } from '../types'
import { EnvEntry } from '../app/types'

type AWSBucketBacking = { bucket: aws.s3.Bucket }

export class Bucket extends Resource<AWSBucketBacking> {
	public readonly name: pulumi.Output<string>
	public readonly endpoint: pulumi.Output<string>
	public readonly accessKey?: pulumi.Output<string>
	public readonly secretKey?: pulumi.Output<string>

	constructor(outputs: BucketOutputs, backing: AWSBucketBacking | {}) {
		super(backing)

		this.name = outputs.name
		this.endpoint = outputs.endpoint
		this.accessKey = outputs.accessKey
		this.secretKey = outputs.secretKey
	}

	addLifecycleRules(args: { id: string, rules: LifecycleRule[] }) {
		if (isLocalStack(this.stack)) return

		addS3LifecycleRules(args.id, this.backing('prod').bucket, args.rules)
	}

	getEnvVar(): pulumi.Output<string> {
		return pulumi.all([this.name, this.endpoint, this.accessKey, this.secretKey]).apply(([n, e, a, s]) => JSON.stringify({ name: n, endpoint: e, accessKey: a, secretKey: s }))
	}

	getEnvEntries(prefix: string): EnvEntry[] {
		let envs: EnvEntry[] = [
			{ name: `${prefix}_BUCKET`, value: { type: "value", value: this.name } },
			{ name: `${prefix}_ENDPOINT`, value: { type: "value", value: this.endpoint } },
		]
		
		if (this.accessKey != null)	envs.push({ name: `${prefix}_ACCESS_KEY`, value: { type: "value", value: this.accessKey } })
		if (this.secretKey != null)	envs.push({ name: `${prefix}_SECRET_KEY`, value: { type: "value", value: this.secretKey } })
		if (isLocalStack(this.stack)) envs.push({ name: `${prefix}_FORCE_PATH_STYLE`, value: { type: "value", value: "true" } })

		return envs
	}
}

export function createBucket(args: ResourceArgs<BucketConfig>): Bucket {
	if (isLocalStack(currentStack)) return createMinioBucket(args.id, args)

	return createS3Bucket(args)
}