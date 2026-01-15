import * as pulumi from '@pulumi/pulumi'

export interface BucketConfig {
	bucketName: string
	isPublic?: boolean
	
}

export interface BucketOutputs {
	endpoint: pulumi.Output<string>
	name: pulumi.Output<string>
	accessKey?: pulumi.Output<string>
	secretKey?: pulumi.Output<string>
}

export type StorageClass = 'GLACIER' | 'STANDARD_IA' | 'ONEZONE_IA' | 'INTELLIGENT_TIERING' | 'DEEP_ARCHIVE' | 'GLACIER_IR'

export interface LifecycleRule {
	id: string
	filter?: { prefix: string }
	transitions: { days: number; storageClass: StorageClass }[]
}