const { loadEnv, defineConfig } = require('@medusajs/framework/utils')
const path = require('path')
const fs = require('fs')

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const resolveModule = (name: string): string => {
  const compiled = path.join(process.cwd(), '.medusa', 'server', 'src', 'modules', name)
  const source   = path.join(process.cwd(), 'src', 'modules', name)
  if (fs.existsSync(compiled)) return compiled
  return source
}

const buildConfig = async () => {
  // CORS is handled dynamically at request-time by src/api/middlewares.ts
  // so new clinics work immediately without restart.
  const storeCors = (process.env.STORE_CORS || 'http://localhost:8000').split(',')
  const adminCors = (process.env.ADMIN_CORS || 'http://localhost:9000').split(',')
  const authCors  = (process.env.AUTH_CORS  || 'http://localhost:9000').split(',')

  return defineConfig({
    admin: { disable: false },
    projectConfig: {
      databaseUrl: process.env.DATABASE_URL,
      http: {
        storeCors,
        adminCors,
        authCors,
        jwtSecret:    process.env.JWT_SECRET    || 'supersecret',
        cookieSecret: process.env.COOKIE_SECRET || 'supersecret',
        // Essential for auth session persistence on HTTP Elastic Beanstalk links
        authMethods: ["emailpass"],
        cookieSecure: false, 
        cookieSameSite: "lax",
      }
    },
    modules: [
      { resolve: resolveModule('provider-integration') },
      { resolve: resolveModule('clinic-ops') },
      { resolve: resolveModule('clinic') },
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [{
            resolve: '@medusajs/medusa/payment-stripe',
            id: 'stripe',
            options: { apiKey: process.env.STRIPE_API_KEY, capture: true },
          }],
        },
      },
      {
        resolve: '@medusajs/medusa/notification',
        options: {
          providers: [{
            resolve: resolveModule('resend'),
            id: 'resend',
            options: {
              channels: ['email'],
              api_key: process.env.RESEND_API_KEY,
              from:    process.env.RESEND_FROM_EMAIL,
            },
          }],
        },
      },
    ],
  })
}

module.exports = buildConfig()
