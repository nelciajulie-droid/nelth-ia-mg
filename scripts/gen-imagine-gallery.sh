#!/bin/bash
# Nelth-IA Images — galerie d'inspiration : 10 visuels réels générés par IA
# (assets statiques du studio ; les prompts FR associés sont réutilisables
# par les utilisateurs via le moteur Nelthai).
set -u
G=/home/z/my-project/public/static/imagine/gallery
mkdir -p "$G"

gen() { # id size prompt
  local id="$1"
  local size="$2"
  local prompt="$3"
  local out="$G/$id.png"
  if [ -s "$out" ]; then echo "SKIP $id"; return 0; fi
  echo "GEN $id ..."
  z-ai image -p "$prompt" -o "$out" -s "$size" && echo "OK  $id ($(stat -c%s "$out" 2>/dev/null) bytes)" || echo "ERR $id"
}

gen photorealistic  864x1152 "Photorealistic portrait of a confident explorer woman in her 30s, weathered linen field shirt, golden rim light, shallow depth of field, 85mm lens, detailed skin texture, National Geographic style, high quality"
gen anime           1024x1024 "Young aviator girl with windblown hair standing on a floating island promontory at dawn, 1990s cel anime style, hand painted sky, dramatic clouds, studio ghibli inspiration, crisp linework, vibrant"
gen 3d              1024x1024 "Adorable stylized 3D fox cub with oversized ears sitting in a dreamy bioluminescent forest, soft global illumination, subsurface scattering, Pixar quality character render, cinematic depth of field"
gen illustration    1152x864  "Watercolor illustration of a bustling Madagascan village market at midday, vendors with woven baskets, zebu cart, baobab in background, loose brushwork, warm palette, paper texture"
gen architecture    1344x768  "Organic modernist villa cantilevered over an ocean cliff at sunset, travertine and curved concrete, infinity pool edge merging with horizon, warm dusk light, architectural photography, ultra detailed"
gen nature          1152x864  "Avenue of giant baobabs of Madagascar at misty sunrise, soft god rays through the haze, dirt road leading in, ochre and sage palette, fine art nature photography"
gen fashion         864x1152  "Editorial fashion photograph, model wearing a sculptural turquoise gown, minimal studio backdrop, dramatic single-source lighting, high detail fabric folds, Vogue editorial style"
gen product         1024x1024 "Premium wireless headphones floating weightlessly, matte graphite and brushed copper accents, studio product photography on soft neutral background, crisp specular highlights, advertising quality"
gen wallpaper       1344x768  "Minimal dreamy abstract landscape wallpaper, layered pastel violet and peach hills under a huge pale sun, subtle grain, flat gradient sky, calm and airy, desktop wallpaper composition"
gen art             1024x1024 "Bold abstract expressionist painting, sweeping gestural brushstrokes, amber ochre deep indigo and ivory palette, thick impasto texture, gallery canvas, dynamic composition"

echo "DONE-ALL"
