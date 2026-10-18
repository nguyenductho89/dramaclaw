# Ad Video Workflow

For ad videos, ad-delivery material and short-video ads.

## Material requirements

- One of the following is required: product images, product photos, a product brief, a product link, an existing product description, or a product the user describes in chat.
- Recommended: target audience, core selling points, delivery platform, final duration, aspect ratio, brand tone, CTA.
- Optional: reference ads, banned words, price/offers, competitors, voiceover style, subtitle language, number of A/B versions.

With only a product image you can also start planning, no screenplay needed; first create the image input, visual understanding, selling-point extraction and Hook branches.

## Production chain

`product input / image material -> visual understanding -> audience analysis -> selling-point extraction -> Hook plan -> ad script -> A/B versions -> shot script -> image/video assets -> voiceover/music -> final composition -> review and optimization`

## Dynamic expansion

- When the user has only a product image, start from `product_image_input` and `visual_analysis`.
- When the user has a product brief, start from `product_brief`.
- With multiple platforms, split the Hook, aspect ratio, duration and CTA by platform.
- For A/B testing, each Hook or core selling point forms a version branch.
- Do not generate a short-drama-style character/episode structure unless the user explicitly asks for a story-driven ad.
