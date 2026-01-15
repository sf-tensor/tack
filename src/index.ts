/**
 * @sf-tensor/tack
 * 
 * A strongly-typed, stack-aware Pulumi infrastructure-as-code framework for AWS.
 */

// Core types and configuration
export {
	// Types
	type Region,
	type USRegion,
	type USEastRegion,
	type USWestRegion,
	type AsiaRegion,
	type EuropeRegion,
	type Stack,
	type ResourceArgs,
	type Repository,
	type TackConfig,
	
	// Utilities
	isLocalStack,
	getOrigin,
	stackSwitch,
	
	// Configuration
	configure,
	getCurrentStack,
	getGithubConnectionArn,
	getCurrentAccountId,
	
	// Backwards compat
	currentStack,
	githubConnectorArn,
	currentAccountId,
	
	// Base class
	Resource
} from './types'

// App deployment (formerly bun)
export {
	BunApp,
	createBunApp,
	Role,
	// New names (aliases)
	App,
	createApp
} from './app'

export {
	type BunAppConfig,
	type BunAppOutputs,
	type AppConfig,
	type AppOutputs,
	type EnvEntry,
	type DevPodConfig,
	type NativeSecretEnvEntry,
	getEnvironmentVariables,
	getNativeSecretKey,
	getSecretArn
} from './app/types'

export { generateNpmRc } from './app/util'

// Bucket / S3
export { Bucket, createBucket } from './bucket'
export { type BucketConfig, type LifecycleRule } from './bucket/types'

// Certificate
export { createCertificate, type CertificateArgs } from './certificate'

// CI/CD
export { createDeploymentManager } from './cicd'
export { type DeploymentManager } from './cicd/deployManager'
export { createAppEcrRepositories, type EcrRepositories } from './cicd/ecr'

// Cluster / EKS
export { Cluster, createCluster } from './cluster'

// Database / RDS
export {
	createDatabaseInstance,
	Database,
	DatabaseUser,
	DatabaseInstance,
	type DatabaseInstanceConfig,
	type CreateUserConfig,
	type CreateDatabaseConfig,
	RdsDatabaseInstance,
	LocalDatabaseInstance
} from './database'

// DNS
export { createDnsRecord, type DnsRecordArgs } from './dns'

// Docker
export { buildImage } from './docker/builder'

// IAM
export { createOidcRole } from './iam/role'

// Load Balancer
export { createLoadBalancer } from './loadbalancer'

// Networking
export { NetworkBuilder } from './networking/planner'
export { Vpc, createVpc } from './networking/vpc'
export { Subnet } from './networking/subnet'

// Secrets
export { createSecret } from './secret'
export { readSecretsFile, createLocalSecretsForApp, type LocalSecretsConfig } from './secrets'
