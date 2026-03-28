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
  const storeCors = process.env.STORE_CORS || 'http://localhost:8000'
  const adminCors = process.env.ADMIN_CORS || 'http://localhost:9000'
  const authCors  = process.env.AUTH_CORS  || 'http://localhost:9000'

  return defineConfig({
    admin: { disable: false },
    projectConfig: {
      databaseUrl: process.env.DATABASE_URL,
      http: {
        storeCors,
        adminCors,
        authCors,
        jwtSecret: process.env.JWT_SECRET || '11a0082c825ab97a36ff3b2c7e408d149534bb55bc8a7c5f6330d8dc3a8150b2',
        cookieSecret: process.env.COOKIE_SECRET || 'fdccd0b02f072d93ba1e0ef683aba3c9c1f7071f416fd3d3be2c16197767776b',
      }
    },
    modules: [
      { resolve: resolveModule('provider-integration') },
      { resolve: resolveModule('clinic-ops') },
      { resolve: resolveModule('clinic') },
      {
        resolve: "@medusajs/medusa/file",
        options: {
          providers: [
            process.env.S3_BUCKET ? {
              resolve: "@medusajs/file-s3",
              id: "s3",
              options: {
                file_url: `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com`,
                access_key_id: process.env.S3_ACCESS_KEY_ID,
                secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
                region: process.env.S3_REGION,
                bucket: process.env.S3_BUCKET,
                prefix: "medusa",
              },
            } : {
              resolve: "@medusajs/file-local",
              id: "local",
              options: {
                backend_url: process.env.MEDUSA_BACKEND_URL
                  ? `${process.env.MEDUSA_BACKEND_URL}/static`
                  : "http://localhost:9000/static",
              },
            },
          ],
        },
      },
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