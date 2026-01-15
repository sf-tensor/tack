import * as aws from '@pulumi/aws'

import { SubnetAllocation, parseCidr, ipToString, alignToSubnetBoundary } from './cidr'
import { currentStack, isLocalStack, Region } from '../types'
import { createVpc, Vpc } from './vpc'
import { Subnet } from './subnet'

export interface VpcConfig<N extends string = string> {
	name: N
	region: Region
	cidrBlock: string
}

interface SubnetDefinition<N extends string = string> {
	name: N
	prefixLength: number
}

/**
 * Fully typed network plan with autocomplete for VPC names, AZs, and subnet names
 */
export type NetworkPlan<
	VpcName extends string,
	AZ extends string,
	SubnetName extends string
> = {
	[V in VpcName]: {
		subnets: {
			[A in AZ]: {
				[S in SubnetName]: SubnetAllocation
			}
		};
		vpc: Vpc
	}
}

/**
 * Fluent builder for network CIDR planning.
 *
 * This is a PLANNING-ONLY utility. It does NOT create AWS resources.
 * Use this to calculate CIDR allocations before using Vpc/Subnet classes.
 *
 * @example
 * const plan = NetworkBuilder
 *     .vpc([
 *         { name: 'production', cidrBlock: '10.0.0.0/16' },
 *         { name: 'development', cidrBlock: '10.10.0.0/16' }
 *     ] as const, ['us-east-2a', 'us-east-2b'] as const)
 *         .subnet('public', '/24')
 *         .subnet('app', '/23')
 *         .subnet('isolated', '/24')
 *         .subnet('database', '/25')
 *         .subnet('reserved', '/24')
 *     .build()
 *
 * plan['production'].subnets['us-east-2a']['public'].cidrBlock  // '10.0.0.0/24'
 * plan['production'].subnets['us-east-2a']['public'].next()     // '10.0.0.4'
 * plan['invalid']  // TypeScript error!
 */
export class NetworkBuilder<
	VpcName extends string = never,
	AZ extends string = never,
	SubnetName extends string = never
> {
	private vpcs: VpcConfig<VpcName>[]
	private azs: AZ[]
	private subnets: SubnetDefinition<SubnetName>[] = []

	private constructor(vpcs: VpcConfig<VpcName>[], azs: AZ[]) {
		this.vpcs = vpcs
		this.azs = azs
	}

	/**
	 * Start building a network plan
	 * @param vpcs Array of VPC configurations (use `as const` for type inference)
	 * @param availabilityZones Array of AZ strings (use `as const` for type inference)
	 */
	static vpc<
		V extends readonly VpcConfig<string>[],
		A extends readonly string[]
	>(
		vpcs: V,
		availabilityZones: A
	): NetworkBuilder<V[number]['name'], A[number], never> {
		if (vpcs.length === 0) {
			throw new Error('At least one VPC must be provided')
		}
		if (availabilityZones.length === 0) {
			throw new Error('At least one availability zone must be provided')
		}

		const vpcNames = new Set<string>()
		for (const vpc of vpcs) {
			if (vpcNames.has(vpc.name)) {
				throw new Error(`Duplicate VPC name: ${vpc.name}`)
			}
			vpcNames.add(vpc.name)
			parseCidr(vpc.cidrBlock)
		}

		return new NetworkBuilder(
			vpcs as unknown as VpcConfig<V[number]['name']>[],
			availabilityZones as unknown as A[number][]
		)
	}

	/**
	 * Define a subnet tier with explicit size
	 * @param name Subnet tier name (e.g., 'public', 'app', 'database')
	 * @param size CIDR prefix size (e.g., '/24' or 24). Defaults to '/24'
	 */
	subnet<S extends string>(
		name: S,
		size: string | number = '/24'
	): NetworkBuilder<VpcName, AZ, SubnetName | S> {
		const prefixLength = typeof size === 'string'
			? parseInt(size.replace('/', ''), 10)
			: size

		if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
			throw new Error(`Invalid subnet size: ${size}`)
		}

		if (this.subnets.some(s => (s.name as string) === name)) {
			throw new Error(`Duplicate subnet name: ${name}`)
		}

		const newBuilder = new NetworkBuilder<VpcName, AZ, SubnetName | S>(
			this.vpcs,
			this.azs
		)
		newBuilder.subnets = [
			...this.subnets as SubnetDefinition<SubnetName | S>[],
			{ name, prefixLength } as SubnetDefinition<SubnetName | S>
		]
		return newBuilder
	}

	/**
	 * Build and validate the network plan
	 */
	build(): NetworkPlan<VpcName, AZ, SubnetName> {
		const plan = {} as NetworkPlan<VpcName, AZ, SubnetName>

		for (const vpc of this.vpcs) {
			plan[vpc.name] = { subnets: {} as { [A in AZ]: { [S in SubnetName]: SubnetAllocation } }, vpc: undefined as unknown as Vpc }
			const vpcCidr = parseCidr(vpc.cidrBlock)
			const vpcSize = Math.pow(2, 32 - vpcCidr.prefixLength)
			const vpcEndIp = vpcCidr.baseIp + vpcSize - 1

			let nextAvailableIp = vpcCidr.baseIp

			const vpcResource: Vpc = createVpc({
				id: `${vpc.name}-vpc`,
				name: `${vpc.name}-${currentStack}`,
				cidrBlock: vpc.cidrBlock,
				region: vpc.region
			})
			plan[vpc.name].vpc = vpcResource

			// Track subnets for routing
			const publicSubnetIds: aws.ec2.Subnet[] = []
			const privateSubnetIds: aws.ec2.Subnet[] = []
			const appSubnetIds: aws.ec2.Subnet[] = [] // One per AZ for VPC endpoints

			for (const az of this.azs) {
				plan[vpc.name].subnets[az] = {} as { [S in SubnetName]: SubnetAllocation }

				for (const subnetDef of this.subnets) {
					const subnetSize = Math.pow(2, 32 - subnetDef.prefixLength)
					let alignedIp = alignToSubnetBoundary(nextAvailableIp, subnetDef.prefixLength)

					if (alignedIp < nextAvailableIp) {
						alignedIp = alignedIp + subnetSize
					}

					const subnetEndIp = alignedIp + subnetSize - 1

					if (subnetEndIp > vpcEndIp) {
						throw new Error(
							`Subnet '${subnetDef.name}' in VPC '${vpc.name}' AZ '${az}' ` +
							`exceeds VPC CIDR range. Requested /${subnetDef.prefixLength} at ` +
							`${ipToString(alignedIp)}, but VPC ends at ${ipToString(vpcEndIp)}`
						)
					}

					let subnetResource: Subnet = vpcResource!.createSubnet({
						id: `${vpc.name}-${az}-${subnetDef.name}-subnet`,
						name: `${vpc.name}-${currentStack}-${az}-${subnetDef.name}`,
						availabilityZone: az,
						cidrBlock: `${ipToString(alignedIp)}/${subnetDef.prefixLength}`,
						region: vpc.region
					})

					// Track subnet for routing based on name (only for non-local stacks)
					if (!isLocalStack(currentStack)) {
						if (subnetDef.name === 'public') {
							publicSubnetIds.push(subnetResource.backing('prod').subnet)
						} else {
							privateSubnetIds.push(subnetResource.backing('prod').subnet)
							// Track app subnets separately for VPC endpoints (one per AZ)
							if (subnetDef.name === 'app') {
								appSubnetIds.push(subnetResource.backing('prod').subnet)
							}
						}
					}

					const cidrBlock = `${ipToString(alignedIp)}/${subnetDef.prefixLength}`;
					plan[vpc.name].subnets[az][subnetDef.name] = new SubnetAllocation({
						cidrBlock,
						name: subnetDef.name,
						vpcName: vpc.name,
						availabilityZone: az,
						subnet: subnetResource
					})

					nextAvailableIp = alignedIp + subnetSize
				}
			}

			if (isLocalStack(currentStack)) continue

			const igw = new aws.ec2.InternetGateway(`${vpc.name}-igw`, {
				vpcId: vpcResource.vpcId(),
				tags: { Name: `${vpc.name}-${currentStack}-igw`, stack: currentStack }
			})

			const publicRouteTable = new aws.ec2.RouteTable(`${vpc.name}-public-rt`, {
				vpcId: vpcResource.vpcId(),
				routes: [{
					cidrBlock: '0.0.0.0/0',
					gatewayId: igw.id
				}],
				tags: { Name: `${vpc.name}-${currentStack}-public-rt`, stack: currentStack }
			})

			for (let i = 0; i < publicSubnetIds.length; i++) {
				new aws.ec2.RouteTableAssociation(`${vpc.name}-public-rta-${i}`, {
					subnetId: publicSubnetIds[i].id,
					routeTableId: publicRouteTable.id
				})
			}

			for (let i = 0; i < publicSubnetIds.length; i++) {
				new aws.ec2.VpcBlockPublicAccessExclusion(`${vpc.name}-bpa-exclusion-${i}`, {
					internetGatewayExclusionMode: 'allow-bidirectional',
					subnetId: publicSubnetIds[i].id,
					tags: { Name: `${vpc.name}-${currentStack}-bpa-exclusion-${i}`, stack: currentStack }
				})
			}

			if (publicSubnetIds.length > 0) {
				const natEip = new aws.ec2.Eip(`${vpc.name}-nat-eip`, {
					domain: 'vpc',
					tags: { Name: `${vpc.name}-${currentStack}-nat-eip`, stack: currentStack }
				})

				const natGateway = new aws.ec2.NatGateway(`${vpc.name}-nat`, {
					allocationId: natEip.id,
					subnetId: publicSubnetIds[0].id,
					tags: { Name: `${vpc.name}-${currentStack}-nat`, stack: currentStack }
				}, { dependsOn: [igw] })

				const privateRouteTable = new aws.ec2.RouteTable(`${vpc.name}-private-rt`, {
					vpcId: vpcResource.vpcId(),
					routes: [{
						cidrBlock: '0.0.0.0/0',
						natGatewayId: natGateway.id
					}],
					tags: { Name: `${vpc.name}-${currentStack}-private-rt`, stack: currentStack }
				})

				for (let i = 0; i < privateSubnetIds.length; i++) {
					new aws.ec2.RouteTableAssociation(`${vpc.name}-private-rta-${i}`, {
						subnetId: privateSubnetIds[i].id,
						routeTableId: privateRouteTable.id
					})
				}

				const endpointSg = new aws.ec2.SecurityGroup(`${vpc.name}-endpoint-sg`, {
					vpcId: vpcResource.vpcId(),
					name: `${vpc.name}-${currentStack}-vpc-endpoints`,
					description: 'Security group for VPC endpoints',
					ingress: [{
						protocol: 'tcp',
						fromPort: 443,
						toPort: 443,
						cidrBlocks: [vpc.cidrBlock]
					}],
					egress: [{
						protocol: '-1',
						fromPort: 0,
						toPort: 0,
						cidrBlocks: ['0.0.0.0/0']
					}],
					tags: { Name: `${vpc.name}-${currentStack}-endpoint-sg`, stack: currentStack }
				})

				new aws.ec2.VpcEndpoint(`${vpc.name}-s3-endpoint`, {
					vpcId: vpcResource.vpcId(),
					serviceName: `com.amazonaws.${vpc.region}.s3`,
					vpcEndpointType: 'Gateway',
					routeTableIds: [privateRouteTable.id, publicRouteTable.id],
					tags: { Name: `${vpc.name}-${currentStack}-s3-endpoint`, stack: currentStack }
				})

				const interfaceEndpoints = ['ecr.api', 'ecr.dkr', 'sts', 'logs', 'ec2']
				for (const service of interfaceEndpoints) {
					new aws.ec2.VpcEndpoint(`${vpc.name}-${service.replace('.', '-')}-endpoint`, {
						vpcId: vpcResource.vpcId(),
						serviceName: `com.amazonaws.${vpc.region}.${service}`,
						vpcEndpointType: 'Interface',
						subnetIds: appSubnetIds.map(s => s.id),
						securityGroupIds: [endpointSg.id],
						privateDnsEnabled: true,
						tags: { Name: `${vpc.name}-${currentStack}-${service}-endpoint`, stack: currentStack }
					})
				}
			}
		}

		return plan
	}
}
