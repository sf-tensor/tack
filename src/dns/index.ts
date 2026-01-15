import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'

export interface DnsRecordArgs {
	id: string
	recordName: string
	albHostname: pulumi.Input<string>
	zoneId: pulumi.Input<string>
}

export function createDnsRecord(args: DnsRecordArgs): cloudflare.DnsRecord {
	return new cloudflare.DnsRecord(args.id, {
		zoneId: args.zoneId,
		name: args.recordName,
		type: 'CNAME',
		content: args.albHostname,
		proxied: true,
		ttl: 1
	})
}
