import * as aws from '@pulumi/aws'
import * as pulumi from "@pulumi/pulumi"

export type USEastRegion		= 'us-east-1' | 'us-east-2'
export type USWestRegion		= 'us-west-1' | 'us-west-2'
export type USRegion			= USEastRegion | USWestRegion

export type AsiaEastRegion		= 'ap-east-1' | 'ap-east-2'
export type AsiaSouthRegion		= 'ap-south-1' | 'ap-south-2'
export type AsiaSouthEastRegion	= 'ap-southeast-1' | 'ap-southeast-2' | 'ap-southeast-3' | 'ap-southeast-5' | 'ap-southeast-4' | 'ap-southeast-6' | 'ap-southeast-7' 
export type AsiaNorthEastRegion	= 'ap-northeast-1' | 'ap-northeast-2' | 'ap-northeast-3'
export type AsiaRegion			= AsiaEastRegion | AsiaSouthRegion | AsiaSouthEastRegion | AsiaNorthEastRegion


export type EuropeCentralRegion	= 'eu-central-1' | 'eu-central-2'
export type EuropeWestRegion	= 'eu-west-1' | 'eu-west-2' | 'eu-west-3'
export type EuropeSouthRegion	= 'eu-south-1' | 'eu-south-2'
export type EuropeNorthRegion	= 'eu-north-1'
export type EuropeRegion		= EuropeCentralRegion | EuropeWestRegion | EuropeSouthRegion | EuropeCentralRegion

export type AfricaRegion		= 'af-south-1'
export type CanadaRegion		= 'ca-central-1' | 'ca-west-1'
export type IsraelRegion		= 'il-central-1'
export type MexicoRegion		= 'mx-central-1' | 'me-south-1' | 'me-central-1'
export type SouthAmericaRegion 	= 'sa-east-1'

// GovCloud is explicitly *not* included below as it requires all sorts of special fun stuff
export type Region				= USRegion | AsiaRegion | EuropeRegion | AfricaRegion | CanadaRegion | IsraelRegion | MexicoRegion | SouthAmericaRegion

export type Stack = 'development' | 'local-staging' | 'staging' | 'production'
export type ResourceArgs<T> = T & { id: string, region: Region, deps?: pulumi.Input<pulumi.Resource>[] }

export function isLocalStack(stack: Stack): boolean {
	return stack === 'local-staging' || stack === 'development'
}

export type Repository = { type: 'github'; org: string; repo: string }
export function getOrigin(repo: Repository) {
	if (repo.type == 'github') {
		return `git@github.com:${repo.org}/${repo.repo}.git`
	}

	throw new Error("Invalid repository")
}

// Configuration interface for explicit configuration
export interface TackConfig {
	stack?: Stack
	githubConnectionArn?: string
}

let _config: TackConfig = {}

/**
 * Configure tack with explicit settings.
 * Call this at the start of your Pulumi program to override default behavior.
 */
export function configure(config: TackConfig): void {
	_config = { ..._config, ...config }
}

/**
 * Get the current stack. Uses configured value or falls back to Pulumi stack name.
 */
export function getCurrentStack(): Stack {
	return _config.stack ?? (pulumi.getStack() as unknown as Stack)
}

/**
 * Get the GitHub connection ARN for CodeBuild.
 */
export function getGithubConnectionArn(): string {
	if (_config.githubConnectionArn) {
		return _config.githubConnectionArn
	}
	const config = new pulumi.Config()
	return config.require('githubConnectionArn')
}

/**
 * Get the current AWS account ID.
 */
export function getCurrentAccountId(): pulumi.Output<string> {
	return pulumi.output(aws.getCallerIdentity()).accountId
}

// Backwards compatibility - these are now computed from the configuration
export const currentStack = getCurrentStack()
export const githubConnectorArn = isLocalStack(currentStack) ? '<invalid>' : (() => {
	try {
		return getGithubConnectionArn()
	} catch {
		return '<not-configured>'
	}
})()
export const currentAccountId = getCurrentAccountId()

export function stackSwitch<T>(config: Partial<Record<Stack, T>>, default_?: T): T {
	return config[getCurrentStack()] ?? default_!
}

export abstract class Resource<P, L = {}> {
	protected stack: Stack
	private _backing: L | P

	constructor(backing: L | P) {
		this.stack = getCurrentStack()
		this._backing = backing
	}

	public backing(key: 'local'): L;
	public backing(key: 'prod'): P;
	public backing(key: 'local' | 'prod'): L | P {
		if (key === 'local') {
			return this._backing as L
		} else {
			return this._backing as P
		}
	}
}
