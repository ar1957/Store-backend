const { loadEnv, defineConfig } = require('@medusajs/framework/utils')
const pg = require('pg')

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// Logic to fetch clinic domains for dynamic CORS
const getClinicDomains = async () => {
  if (!process.env.DATABASE_URL) return []
  try {
    const pool = new pg.Pool({ 
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
    })
    const result = await pool.query(
      `SELECT domains FROM clinic WHERE deleted_at IS NULL AND is_active = true`
    )
    await pool.end()
    return result.rows
      .flatMap((r) => r.domains || [])
      .filter(Boolean)
      .map((d) => {
        if (d.startsWith('http')) return d
        if (d.includes('localhost')) return `http://${d}`
        return `https://${d}`
      })
  } catch (e) {
    console.warn('[CORS] Could not fetch clinic domains from DB:', e.message)
    return []
  }
}

const buildConfig = async () => {
  const staticStoreCors = process.env.STORE_CORS || 'http://localhost:8000'
  const staticAdminCors = process.env.ADMIN_CORS || 'http://localhost:9000'
  const staticAuthCors  = process.env.AUTH_CORS  || 'http://localhost:9000'

  const clinicDomains = await getClinicDomains()

  const storeCors = [
    ...staticStoreCors.split(','),
    ...clinicDomains,
  ].filter(Boolean).join(',')

  return defineConfig({
    admin: {
      disable: false,
    },
    projectConfig: {
      databaseUrl: process.env.DATABASE_URL,
      http: {
        storeCors,
        adminCors: staticAdminCors,
        authCors:  staticAuthCors,
        jwtSecret:    process.env.JWT_SECRET    || 'supersecret',
        cookieSecret: process.env.COOKIE_SECRET || 'supersecret',
      }
    },
    modules: [
      {
        // Using absolute path via process.cwd() to ensure Medusa finds migrations on AWS
        resolve: process.cwd() + '/.medusa/server/src/modules/provider-integration',
      },
      {
        resolve: process.cwd() + '/.medusa/server/src/modules/clinic-ops',
      },
      {
        resolve: process.cwd() + '/.medusa/server/src/modules/clinic',
      },
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/payment-stripe',
              id: 'stripe',
              options: {
                apiKey: process.env.STRIPE_API_KEY,
                capture: true,
              },
            },
          ],
        },
      },
      {
        resolve: '@medusajs/medusa/notification',
        options: {
          providers: [
            {
              // Resend also uses the absolute path to the compiled module
              resolve: process.cwd() + '/.medusa/server/src/modules/resend',
              id: 'resend',
              options: {
                channels: ['email'],
                api_key: process.env.RESEND_API_KEY,
                from:    process.env.RESEND_FROM_EMAIL,
              },
            },
          ],
        },
      },
    ],
  })
}

module.exports = buildConfig()