import { loadEnv, defineConfig } from '@medusajs/framework/utils'
import pg from 'pg'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const getClinicDomains = async (): Promise<string[]> => {
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
      .flatMap((r: any) => r.domains || [])
      .filter(Boolean)
      .map((d: string) => {
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
        resolve: './src/modules/provider-integration',
      },
      {
        resolve: './src/modules/clinic-ops',
      },
      {
        resolve: './src/modules/clinic',
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
              resolve: './src/modules/resend',
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