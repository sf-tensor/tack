import { createLocalDatabaseInstance, LocalDatabaseInstance } from './local'
import { createRdsDatabaseInstance, RdsDatabaseInstance } from './aws'
import { DatabaseInstance, DatabaseInstanceConfig } from './types'
import { currentStack, isLocalStack, ResourceArgs } from '../types'

export { Database, DatabaseUser, DatabaseInstance, DatabaseInstanceConfig, CreateUserConfig, CreateDatabaseConfig } from './types'
export { RdsDatabaseInstance } from './aws'
export { LocalDatabaseInstance } from './local'

/**
 * Creates a database instance based on the current stack.
 * - In development: Creates a local Kubernetes PostgreSQL instance
 * - In production/staging: Creates an AWS RDS instance
 */
export function createDatabaseInstance(args: ResourceArgs<DatabaseInstanceConfig>): DatabaseInstance {
	if (isLocalStack(currentStack)) return createLocalDatabaseInstance(args.id, args)

	return createRdsDatabaseInstance(args)
}
