type Rgb = [number, number, number]

const BASIC: Rgb[] = [
  [0, 0, 0],
  [255, 0, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
  [255, 255, 255],
  [128, 128, 128],
  [192, 192, 192]
]

const SHADE_VALUES = [255, 255, 165, 165, 127, 127, 76, 76, 38, 38]
const GRAYS = [51, 91, 132, 173, 214, 255]

function hsvToRgb(hue: number, saturation: number, value: number): Rgb {
  const chroma = value * saturation
  const sector = hue / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  let rgb: Rgb

  if (sector < 1) {
    rgb = [chroma, second, 0]
  } else if (sector < 2) {
    rgb = [second, chroma, 0]
  } else if (sector < 3) {
    rgb = [0, chroma, second]
  } else if (sector < 4) {
    rgb = [0, second, chroma]
  } else if (sector < 5) {
    rgb = [second, 0, chroma]
  } else {
    rgb = [chroma, 0, second]
  }

  const base = value - chroma
  return rgb.map((channel) => Math.round((channel + base) * 255)) as Rgb
}

export function aciToRgb(index: number): Rgb {
  if (index >= 1 && index <= 9) {
    return BASIC[index]
  }

  if (index >= 10 && index <= 249) {
    const group = Math.floor((index - 10) / 10)
    const offset = (index - 10) % 10
    const value = SHADE_VALUES[offset] / 255
    const saturation = offset % 2 === 0 ? 1 : 0.5
    return hsvToRgb(group * 15, saturation, value)
  }

  if (index >= 250 && index <= 255) {
    const gray = GRAYS[index - 250]
    return [gray, gray, gray]
  }

  return [248, 250, 252]
}

function toCss(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export function resolveEntityColor(entityColor: number, layerColor: number): string {
  if (entityColor >= 1 && entityColor <= 255) {
    return toCss(aciToRgb(entityColor))
  }
  if (layerColor >= 1 && layerColor <= 255) {
    return toCss(aciToRgb(layerColor))
  }
  return toCss(aciToRgb(7))
}
