const { Client } = require('pg')

/**
 * Lambda handler for executing SQL commands on RDS
 * @param {Object} event
 * @param {string} event.action - 'createUser' or 'createDatabase'
 * @param {string} event.host - Database host
 * @param {number} event.port - Database port
 * @param {string} event.masterUsername - Master username
 * @param {string} event.masterPassword - Master password
 * @param {string} [event.username] - Username to create (for createUser)
 * @param {string} [event.userPassword] - Password for new user (for createUser)
 * @param {string} [event.databaseName] - Database name to create (for createDatabase)
 * @param {string} [event.owner] - Owner of the database (for createDatabase)
 */
exports.handler = async (event) => {
	const { action, host, port, masterUsername, masterPassword } = event

	const client = new Client({
		host,
		port,
		user: masterUsername,
		password: masterPassword,
		database: 'postgres',
		ssl: { rejectUnauthorized: false }
	})

	try {
		await client.connect()

		if (action === 'createUser') {
			const { username, userPassword } = event
			if (!username || !userPassword) {
				throw new Error('username and userPassword are required for createUser')
			}

			// Check if user exists
			const checkResult = await client.query(
				`SELECT 1 FROM pg_roles WHERE rolname = $1`,
				[username]
			)

			if (checkResult.rows.length === 0) {
				// Create user with password (using parameterized query for safety)
				// Note: We have to use string interpolation for the password since
				// PostgreSQL doesn't support parameterized passwords in CREATE ROLE
				const escapedPassword = userPassword.replace(/'/g, "''")
				await client.query(
					`CREATE ROLE "${username}" WITH LOGIN PASSWORD '${escapedPassword}'`
				)
				// Grant the new role to the master user so it can SET ROLE when creating databases with this owner
				await client.query(
					`GRANT "${username}" TO "${masterUsername}"`
				)
				return { success: true, message: `User ${username} created` }
			} else {
				// Update password if user exists
				const escapedPassword = userPassword.replace(/'/g, "''")
				await client.query(
					`ALTER ROLE "${username}" WITH PASSWORD '${escapedPassword}'`
				)
				// Ensure grant exists (idempotent - no error if already granted)
				await client.query(
					`GRANT "${username}" TO "${masterUsername}"`
				)
				return { success: true, message: `User ${username} already exists, password updated` }
			}
		}

		if (action === 'createDatabase') {
			const { databaseName, owner } = event
			if (!databaseName) {
				throw new Error('databaseName is required for createDatabase')
			}

			// Check if database exists
			const checkResult = await client.query(
				`SELECT 1 FROM pg_database WHERE datname = $1`,
				[databaseName]
			)

			if (checkResult.rows.length === 0) {
				// Create database with optional owner
				const ownerClause = owner ? ` OWNER "${owner}"` : ''
				await client.query(`CREATE DATABASE "${databaseName}"${ownerClause}`)
				return { success: true, message: `Database ${databaseName} created` }
			} else {
				return { success: true, message: `Database ${databaseName} already exists` }
			}
		}

		throw new Error(`Unknown action: ${action}`)
	} catch (error) {
		console.error('SQL execution error:', error)
		throw error
	} finally {
		await client.end()
	}
}
