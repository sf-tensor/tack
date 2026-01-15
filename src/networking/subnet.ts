import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

import { isLocalStack, Resource } from "../types";
import { Vpc } from './vpc';

export class Subnet extends Resource<{ subnet: aws.ec2.Subnet; name: string }> {
	private readonly parent: Vpc

	constructor(parent: Vpc, backing: { subnet: aws.ec2.Subnet; name: string } | {}) {
		super(backing)

		this.parent = parent
	}

	subnetId(): pulumi.Output<string> {
		if (isLocalStack(this.stack)) throw new Error('subnetId is not available for local stacks')
		return this.backing('prod').subnet.id
	}
}