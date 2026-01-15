/**
 * CIDR utilities and subnet allocation for network planning
 */

import type { Subnet } from "./subnet"

export interface CidrBlock {
	baseIp: number
	prefixLength: number
}

/**
 * Parse a CIDR string into its components
 */
export function parseCidr(cidr: string): CidrBlock {
	const match = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/)
	if (!match) {
		throw new Error(`Invalid CIDR notation: ${cidr}`)
	}

	const octets = [
		parseInt(match[1], 10),
		parseInt(match[2], 10),
		parseInt(match[3], 10),
		parseInt(match[4], 10)
	]

	for (const octet of octets) {
		if (octet < 0 || octet > 255) {
			throw new Error(`Invalid IP octet in CIDR: ${cidr}`)
		}
	}

	const prefixLength = parseInt(match[5], 10)
	if (prefixLength < 0 || prefixLength > 32) {
		throw new Error(`Invalid prefix length in CIDR: ${cidr}`)
	}

	const baseIp = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0

	// Ensure base IP is aligned to network boundary
	const mask = prefixLength === 0 ? 0 : (~((1 << (32 - prefixLength)) - 1)) >>> 0
	const networkIp = (baseIp & mask) >>> 0

	if (networkIp !== baseIp) {
		throw new Error(
			`CIDR ${cidr} is not properly aligned. ` +
			`Network address should be ${ipToString(networkIp)}/${prefixLength}`
		)
	}

	return { baseIp, prefixLength }
}

/**
 * Convert a 32-bit integer IP to dotted-decimal string
 */
export function ipToString(ip: number): string {
	return [
		(ip >>> 24) & 0xFF,
		(ip >>> 16) & 0xFF,
		(ip >>> 8) & 0xFF,
		ip & 0xFF
	].join('.')
}

/**
 * Convert a dotted-decimal IP string to 32-bit integer
 */
export function stringToIp(ip: string): number {
	const octets = ip.split('.').map(o => parseInt(o, 10))
	if (octets.length !== 4 || octets.some(o => isNaN(o) || o < 0 || o > 255)) {
		throw new Error(`Invalid IP address: ${ip}`)
	}
	return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

/**
 * Align IP to subnet boundary for a given prefix length
 */
export function alignToSubnetBoundary(ip: number, prefixLength: number): number {
	const mask = ~((1 << (32 - prefixLength)) - 1) >>> 0
	return (ip & mask) >>> 0
}

/**
 * Represents a subnet allocation with IP tracking for static assignments.
 *
 * AWS reserves the first 4 IPs and the last IP in each subnet:
 * - .0 = Network address
 * - .1 = VPC router
 * - .2 = DNS server
 * - .3 = Reserved for future use
 * - last = Broadcast
 *
 * Usable IPs start at .4
 */
export class SubnetAllocation {
	readonly name: string
	readonly vpcName: string
	readonly subnet: Subnet
	readonly cidrBlock: string
	readonly prefixLength: number
	readonly availabilityZone: string

	private readonly baseIp: number
	private readonly usableStartIp: number
	private readonly usableEndIp: number
	private currentOffset: number = 0

	constructor(config: {
		cidrBlock: string
		name: string
		vpcName: string
		availabilityZone: string,
		subnet: Subnet
	}) {
		this.name = config.name
		this.subnet = config.subnet
		this.vpcName = config.vpcName
		this.cidrBlock = config.cidrBlock
		this.availabilityZone = config.availabilityZone

		const parsed = parseCidr(config.cidrBlock)
		this.baseIp = parsed.baseIp
		this.prefixLength = parsed.prefixLength

		const subnetSize = Math.pow(2, 32 - this.prefixLength)
		this.usableStartIp = this.baseIp + 4
		this.usableEndIp = this.baseIp + subnetSize - 2
	}

	/**
	 * Returns the next available IP address and advances the counter
	 */
	next(): string {
		const ip = this.usableStartIp + this.currentOffset

		if (ip > this.usableEndIp) {
			throw new Error(
				`No more IPs available in subnet ${this.name} (${this.cidrBlock})`
			)
		}

		this.currentOffset++
		return ipToString(ip)
	}

	/**
	 * Returns the next IP without advancing the counter
	 */
	peek(): string {
		const ip = this.usableStartIp + this.currentOffset
		if (ip > this.usableEndIp) {
			throw new Error(`No more IPs available in subnet ${this.name}`)
		}
		return ipToString(ip)
	}

	/**
	 * Resets the IP allocation counter
	 */
	reset(): void {
		this.currentOffset = 0
	}

	/**
	 * Returns the count of remaining allocatable IPs
	 */
	remaining(): number {
		const usableCount = this.usableEndIp - this.usableStartIp + 1
		return Math.max(0, usableCount - this.currentOffset)
	}
}
