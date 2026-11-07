import type { Skill } from '../types'

export const imageGenerationPrompting: Skill = {
  name: 'image-generation-prompting',
  description:
    'Prompt engineering for AI image generation: the subject-action-environment-lighting-style-camera formula, style keyword vocabulary per look (photorealistic, illustration, 3D, watercolor), negative prompt technique, aspect ratio by use case, and one-variable-at-a-time iteration. Use when the user wants to generate or improve an image, illustration, logo, avatar, banner, miniature or any visual with AI generators (Midjourney, DALL-E, Stable Diffusion style tools).',
  keywords: [
    'image', 'generer une image', 'image generation', 'ai art',
    'midjourney', 'dalle', 'stable diffusion', 'prompt', 'prompts',
    'prompt engineering', 'creer une image', 'illustration', 'generer un logo',
    'photo ia', 'ai image', 'art generatif', "generateur d'images",
    'aspect ratio', "format d'image", 'negative prompt',
    'banniere', 'avatar', 'image ia', 'texte to image', 'visuel'
  ],
  body: `# Image Generation Prompting

## Prompt formula (assemble in this order)
subject + action/pose + environment + lighting + style/medium + camera/composition + quality modifiers.
Worked example: "a violinist mid-performance, eyes closed, on a rain-soaked neon-lit Tokyo street at night, cinematic rim lighting with warm shop-window glow, photorealistic, shot on 85mm f/1.4, shallow depth of field, ultra-detailed".
Weak prompts are usually just a subject; strong prompts specify at least five of the seven slots.

## Style keyword vocabulary per look
- Photorealistic: editorial photography, natural skin texture, 85mm, f/1.8, soft window light, candid.
- Cinematic: film still, anamorphic lens, teal-and-orange grade, dramatic shadows, 35mm.
- 3D render: octane render, subsurface scattering, studio HDRI lighting, isometric view.
- Flat illustration: flat vector illustration, bold outlines, limited palette, editorial style.
- Watercolor: watercolor painting, soft washes, visible paper texture, loose brush strokes.
- Retro print: risograph, screen print, halftone grain, duotone palette.
- Anime: cel shading, key visual, clean lineart, studio quality.
- Minimal: negative space, geometric composition, single accent color.

## Negative prompt technique
List what must not appear: "blurry, deformed hands, extra fingers, watermark, text, logo, lowres, oversaturated, plastic skin".
Keep it to 5-10 tokens. Remember that negative prompts also steer style: remove entries that fight the target look (do not write "painting" in the negative when generating a painting).

## Aspect ratio by use case
- 16:9 — website heroes, YouTube thumbnails, presentation banners.
- 1:1 — social feed posts, avatars, product shots.
- 9:16 — stories, reels, TikTok, phone wallpapers.
- 4:5 — Instagram portrait feed (maximum screen coverage).
- 3:2 or 2:3 — print-like editorial content.

## Iteration method — one variable at a time
1. Generate 4 candidates with the same seed.
2. Pick the closest; change exactly one dimension (lighting OR pose OR style) and regenerate.
3. Keep notes of winning prompt fragments and reuse them.
Never change three things at once: you lose track of what actually worked.

## Language rule (important for French users)
Prompts perform best in English. Translate and EXPAND the user's French request into a rich English prompt: add lighting, lens, mood and style even when the user only wrote "une photo de mon chat astronaute". Show the user the final English prompt used. Keep French only for words that must appear INSIDE the image itself, and quote them explicitly ("the word Boulangerie on the shop sign") — and warn that generated text is often misspelled.

## Composition control
- Placement: "subject on the left third, empty copy space on the right" when text will be overlaid later.
- Camera height and distance: low angle, eye level, macro, wide establishing shot.
- When text will be added in post, request clean negative space and low-detail zones, and prefer larger aspect ratios.`
}

export default imageGenerationPrompting
