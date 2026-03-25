const { loadEnv, defineConfig } = require('@medusajs/framework/utils')
const pg = require('pg')
const path = require('path')
const fs = require('fs')

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// __dirname when compiled = <project>/.medusa/server/
// __dirname when running ts-node/dev = <project>/
// So the project root is always 2 levels up from __dirname if compiled,
// or __dirname itself if running from source.
// We detect which by checking if __dirname ends with .medusa/server.
const isCompiled = __dirname.includes('.medusa') || __dirname.includes('medusa/server')
const projectRoot = isCompiled
  ? path.resolve(__dirname, '..', '..')   // .medusa/server -> project root
  : __dirname                              // already at project root

// Resolve a module: on AWS the compiled .medusa/server/src/modules/<name> is used.
// Locally src/modules/<name> is used. Both are absolute paths — no cwd() dependency.
const resolveModule = (name: string): string => {
  const compiled = path.join(projectRoot, '.medusa', 'server', 'src', 'modules', name)
  const source   = path.join(projectRoot, 'src', 'modules', name)
  if (fs.existsSync(compiled)) return compiled
  return source
}

// Fetch clinic domains for CORS — safe if clinic table doesn't exist yet
const getClinicDomains = async (): Promise<string[]> => {
  if (!process.env.DATABASE_URL) return []
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
  })
  try {
    const tableCheck = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'clinic'`
    )
    if (!tableCheck.rowCount) {
      console.warn('[CORS] clinic table does not exist yet — skipping dynamic domains')
      return []
    }
    const result = await pool.query(
      `SELECT domains FROM clinic WHERE deleted_at IS NULL AND is_active = true`
    )
    return result.rows
      .flatMap((r: any) => r.domains || [])
      .filter(Boolean)
      .map((d: string) => {
        if (d.startsWith('http')) return d
        if (d.includes('localhost') || d.includes('.local')) return `http://${d}`
        return `https://${d}`
      })
  } catch (e: any) {
    console.warn('[CORS] Could not fetch clinic domains from DB:', e.message)
    return []
  } finally {
    await pool.end().catch(() => {})
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
        resolve: resolveModule('provider-integration'),
      },
      {
        resolve: resolveModule('clinic-ops'),
      },
      {
        resolve: resolveModule('clinic'),
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
              resolve: resolveModule('resend'),
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
