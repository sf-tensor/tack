/** @type {import('next').NextAdapter} */
const adapter = {
	name: "tack-adapter",

	async modifyConfig(config, { phase }) {
		if (phase === "phase-production-build") {
			return {
				...config,
				output: 'standalone'
			};
		}

		return config;
	}
};

module.exports = adapter;