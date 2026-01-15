import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { Subnet } from './subnet'
import { currentStack, isLocalStack, Resource, ResourceArgs } from '../types'

export class Vpc extends Resource<{ vpc: aws.ec2.Vpc }, {}> {
	constructor(backing: { vpc: aws.ec2.Vpc } | {}) {
		super(backing)
	}

	vpcId(): pulumi.Output<string> {
		if (isLocalStack(this.stack)) throw new Error('vpcId is not available for local stacks')
		return this.backing('prod').vpc.id
	}

	createSubnet(args: ResourceArgs<{ name: string, availabilityZone: string, cidrBlock: string }>): Subnet {
		if (isLocalStack(this.stack)) return new Subnet(this, {})

		const subnet = new aws.ec2.Subnet(`${args.id}-subnet`, {
			vpcId: this.vpcId(),
			region: this.backing('prod').vpc.region,
			availabilityZone: args.availabilityZone,
			cidrBlock: args.cidrBlock,
			mapPublicIpOnLaunch: false,
			tags: {
				Name: args.name,
				stack: currentStack
			}
		}, { dependsOn: args.deps })

		return new Subnet(this, { subnet, name: args.name })
	}
}

export function createVpc(args: ResourceArgs<{ name: string, cidrBlock: string }>): Vpc {
	if (isLocalStack(currentStack)) return new Vpc({})

	const vpc = new aws.ec2.Vpc(args.id, {
		cidrBlock: args.cidrBlock,
		assignGeneratedIpv6CidrBlock: true,
		enableDnsSupport: true,
		enableDnsHostnames: true,
		region: args.region,
		tags: {
			Name: args.name,
			stack: currentStack
		}
	}, { dependsOn: args.deps })

	return new Vpc({ vpc })
}