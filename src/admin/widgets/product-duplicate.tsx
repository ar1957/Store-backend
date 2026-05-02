/**
 * Product Duplicate Widget
 * File: src/admin/widgets/product-duplicate.tsx
 *
 * Adds a "Duplicate Product" button to the product detail page.
 * Copies title, description, options, variants (with prices), and
 * sales channel assignments into a new draft product.
 */

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { useState } from "react"
import { DetailWidgetProps } from "@medusajs/framework/types"
import { HttpTypes } from "@medusajs/types"

function DuplicateProductWidget({ data }: DetailWidgetProps<HttpTypes.AdminProduct>) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null)

  const handleDuplicate = async () => {
    setLoading(true)
    setResult(null)

    try {
      // 1. Fetch full product details (widget data may be partial)
      const res = await fetch(`/admin/products/${data.id}?fields=*variants,*variants.prices,*options,*options.values,*sales_channels`, {
        credentials: "include",
      })
      if (!res.ok) throw new Error(`Failed to fetch product (${res.status})`)
      const { product } = await res.json()

      // 2. Build the create payload
      const payload: Record<string, any> = {
        title: `${product.title} (Copy)`,
        status: "draft",
      }

      if (product.subtitle)     payload.subtitle     = product.subtitle
      if (product.description)  payload.description  = product.description
      if (product.handle)       payload.handle       = `${product.handle}-copy-${Date.now()}`
      if (product.material)     payload.material     = product.material
      if (product.weight)       payload.weight       = product.weight
      if (product.length)       payload.length       = product.length
      if (product.height)       payload.height       = product.height
      if (product.width)        payload.width        = product.width
      if (product.hs_code)      payload.hs_code      = product.hs_code
      if (product.origin_country) payload.origin_country = product.origin_country
      if (product.mid_code)     payload.mid_code     = product.mid_code
      if (product.type_id)      payload.type_id      = product.type_id
      if (product.collection_id) payload.collection_id = product.collection_id
      if (product.discountable !== undefined) payload.discountable = product.discountable
      if (product.external_id)  payload.external_id  = undefined // don't copy external ID

      // Options
      if (product.options?.length) {
        payload.options = product.options.map((o: any) => ({
          title: o.title,
          values: o.values?.map((v: any) => v.value) ?? [],
        }))
      }

      // Variants
      if (product.variants?.length) {
        payload.variants = product.variants.map((v: any) => {
          const variant: Record<string, any> = {
            title: v.title,
            sku: v.sku ? `${v.sku}-copy` : undefined,
            weight: v.weight,
            length: v.length,
            height: v.height,
            width: v.width,
            hs_code: v.hs_code,
            origin_country: v.origin_country,
            mid_code: v.mid_code,
            material: v.material,
          }

          // Prices
          if (v.prices?.length) {
            variant.prices = v.prices.map((p: any) => ({
              amount: p.amount,
              currency_code: p.currency_code,
              ...(p.region_id ? { region_id: p.region_id } : {}),
            }))
          }

          // Option values
          if (v.options?.length) {
            variant.options = v.options.reduce((acc: Record<string, string>, o: any) => {
              // Find the option title from product.options
              const optionDef = product.options?.find((po: any) => po.id === o.option_id)
              if (optionDef) acc[optionDef.title] = o.value
              return acc
            }, {})
          }

          // Remove undefined keys
          Object.keys(variant).forEach(k => variant[k] === undefined && delete variant[k])
          return variant
        })
      }

      // Sales channels
      if (product.sales_channels?.length) {
        payload.sales_channels = product.sales_channels.map((sc: any) => ({ id: sc.id }))
      }

      // Tags
      if (product.tags?.length) {
        payload.tags = product.tags.map((t: any) => ({ value: t.value }))
      }

      // 3. Create the duplicate
      const createRes = await fetch("/admin/products", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!createRes.ok) {
        const err = await createRes.json()
        throw new Error(err.message || `Create failed (${createRes.status})`)
      }

      const { product: created } = await createRes.json()
      setResult({
        type: "success",
        message: `✓ Duplicated as "${created.title}" (ID: ${created.id}) — saved as draft.`,
      })
    } catch (err: any) {
      setResult({ type: "error", message: `✗ ${err.message}` })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      background: "#fff",
      border: "1px solid #E5E7EB",
      borderRadius: "12px",
      padding: "16px 20px",
      marginBottom: "8px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "#111827" }}>Duplicate Product</p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6B7280" }}>
            Creates a copy of this product as a draft, including all variants and prices.
          </p>
        </div>
        <button
          onClick={handleDuplicate}
          disabled={loading}
          style={{
            padding: "8px 16px",
            borderRadius: "8px",
            border: "1px solid #E5E7EB",
            background: loading ? "#F9FAFB" : "#fff",
            fontSize: "13px",
            fontWeight: 500,
            cursor: loading ? "default" : "pointer",
            color: loading ? "#9CA3AF" : "#374151",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {loading ? "⏳ Duplicating…" : "⧉ Duplicate"}
        </button>
      </div>

      {result && (
        <div style={{
          marginTop: 12,
          padding: "8px 12px",
          borderRadius: 8,
          fontSize: 13,
          background: result.type === "success" ? "#F0FDF4" : "#FEF2F2",
          border: `1px solid ${result.type === "success" ? "#BBF7D0" : "#FECACA"}`,
          color: result.type === "success" ? "#166534" : "#991B1B",
        }}>
          {result.message}
          {result.type === "success" && (
            <span
              style={{ marginLeft: 12, cursor: "pointer", textDecoration: "underline", fontSize: 12 }}
              onClick={() => window.location.href = "/app/products"}
            >
              Go to Products →
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export const config = defineWidgetConfig({
  zone: "product.details.before",
})

export default DuplicateProductWidget
