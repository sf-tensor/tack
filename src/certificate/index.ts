import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import * as pulumi from '@pulumi/pulumi'

export interface CertificateArgs {
	id: string
	domainName: string
	subjectAlternativeNames?: string[]
	zoneId: pulumi.Input<string>
}

export function createCertificate(args: CertificateArgs) {
	// Create ACM certificate request
	const certificate = new aws.acm.Certificate(args.id, {
		domainName: args.domainName,
		subjectAlternativeNames: args.subjectAlternativeNames,
		validationMethod: 'DNS'
	})

	// Create Cloudflare DNS records for validation
	const validationRecords = certificate.domainValidationOptions.apply(options =>
		options.map((option, index) =>
			new cloudflare.DnsRecord(`${args.id}-validation-${index}`, {
				zoneId: args.zoneId,
				name: option.resourceRecordName,
				type: option.resourceRecordType,
				content: option.resourceRecordValue,
				ttl: 60,
				proxied: false // Validation records must not be proxied
			})
		)
	)

	// Wait for certificate validation
	const certificateValidation = new aws.acm.CertificateValidation(`${args.id}-validation`, {
		certificateArn: certificate.arn,
		validationRecordFqdns: certificate.domainValidationOptions.apply(options =>
			options.map(option => option.resourceRecordName)
		)
	})

	return {
		certificate,
		certificateArn: certificateValidation.certificateArn,
		validationRecords
	}
}
