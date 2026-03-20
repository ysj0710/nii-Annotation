const CT_WINDOW_PRESETS = [
  {
    id: 'subdural',
    label: '硬膜下窗',
    ww: 160,
    wl: 60,
    keywords: ['subdural', '硬膜下', 'sdh']
  },
  {
    id: 'stroke',
    label: '脑梗窗',
    ww: 40,
    wl: 35,
    keywords: ['stroke', 'infarct', 'ischemia', '脑梗', '缺血']
  },
  {
    id: 'brain',
    label: '脑窗',
    ww: 90,
    wl: 35,
    keywords: ['brain', 'head', 'cranial', '颅脑', '脑', '头颅', 'head ct']
  },
  {
    id: 'bone',
    label: '骨窗',
    ww: 2000,
    wl: 350,
    keywords: ['bone', 'osseous', '骨窗', '骨']
  },
  {
    id: 'lung',
    label: '肺窗',
    ww: 1400,
    wl: -550,
    keywords: ['lung', 'chest', 'thorax', '肺窗', '肺']
  },
  {
    id: 'mediastinal',
    label: '纵隔/软组织窗',
    ww: 400,
    wl: 40,
    keywords: ['mediast', 'soft tissue', '纵隔', '软组织']
  },
  {
    id: 'abdomen',
    label: '腹部窗',
    ww: 400,
    wl: 50,
    keywords: ['abdomen', 'abdominal', '腹部', '腹']
  },
  {
    id: 'liver',
    label: '肝窗',
    ww: 180,
    wl: 60,
    keywords: ['liver', 'hepatic', '肝']
  },
  {
    id: 'pancreas',
    label: '胰腺窗',
    ww: 250,
    wl: 60,
    keywords: ['pancreas', '胰腺', '胰']
  },
  {
    id: 'kidney',
    label: '肾窗',
    ww: 350,
    wl: 40,
    keywords: ['kidney', 'renal', '肾']
  },
  {
    id: 'angio',
    label: '血管窗',
    ww: 750,
    wl: 200,
    keywords: ['cta', 'ctv', 'angio', 'vessel', '血管', '造影']
  },
  {
    id: 'pelvis',
    label: '骨盆/肌肉窗',
    ww: 420,
    wl: 55,
    keywords: ['pelvis', 'muscle', '骨盆', '肌肉']
  }
]

const NON_CT_HINT_RE =
  /(mri|mr |mr_|mr-|pet|spect|ultrasound|us\b|xray|x-ray|dr\b|cr\b|nm\b|flair|dwi|adc|t1\b|t2\b)/i
const CT_HINT_RE =
  /(cta|ctv|ct\b|computed tomography|平扫|增强|头颅ct|胸部ct|腹部ct|cta脑|头颅平扫|ct_)/i

const hasValidRobustWindow = (volume) => {
  const robustMin = Number(volume?.robust_min)
  const robustMax = Number(volume?.robust_max)
  return Number.isFinite(robustMin) && Number.isFinite(robustMax) && robustMax > robustMin
}

const hasFiniteGlobalWindow = (volume) => {
  const min = Number(volume?.global_min)
  const max = Number(volume?.global_max)
  return Number.isFinite(min) && Number.isFinite(max) && max > min
}

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[_\-./]+/g, ' ')

const isLikelyCTByRange = (volume) => {
  const robustMin = Number(volume?.robust_min)
  const robustMax = Number(volume?.robust_max)
  if (Number.isFinite(robustMin) && Number.isFinite(robustMax) && robustMax > robustMin) {
    if (robustMin <= -300 && robustMax >= 300) return true
  }
  const gMin = Number(volume?.global_min)
  const gMax = Number(volume?.global_max)
  if (Number.isFinite(gMin) && Number.isFinite(gMax) && gMax > gMin) {
    if (gMin <= -300 && gMax >= 300) return true
    if (gMax - gMin >= 1400) return true
  }
  return false
}

const matchPresetByText = (text) => {
  if (!text) return null
  for (const preset of CT_WINDOW_PRESETS) {
    if (preset.keywords.some((kw) => text.includes(kw))) {
      return preset
    }
  }
  return null
}

export const inferCTWindowPreset = ({ name = '', seriesDescription = '', studyDescription = '', volume = null } = {}) => {
  const text = normalizeText([name, seriesDescription, studyDescription].filter(Boolean).join(' '))
  if (!text && !volume) return null

  const hasNonCtHint = NON_CT_HINT_RE.test(text)
  const hasCtHint = CT_HINT_RE.test(text)
  const likelyCt = hasCtHint || isLikelyCTByRange(volume)

  if (!likelyCt || (hasNonCtHint && !hasCtHint)) return null

  const matched = matchPresetByText(text)
  if (matched) return matched

  // 未命中具体部位时，使用软组织默认窗，保证同批切换观感一致。
  return {
    id: 'soft-default',
    label: 'CT默认软组织窗',
    ww: 400,
    wl: 40
  }
}

export const resolveAutoWindowRange = ({ volume = null, imageMeta = {} } = {}) => {
  if (!volume) return null
  const preset = inferCTWindowPreset({
    name: imageMeta?.name,
    seriesDescription: imageMeta?.seriesDescription,
    studyDescription: imageMeta?.studyDescription,
    volume
  })
  if (preset) {
    return {
      min: Number(preset.wl) - Number(preset.ww) / 2,
      max: Number(preset.wl) + Number(preset.ww) / 2,
      preset
    }
  }
  if (hasValidRobustWindow(volume)) {
    return {
      min: Number(volume.robust_min),
      max: Number(volume.robust_max),
      preset: null
    }
  }
  if (hasFiniteGlobalWindow(volume)) {
    return {
      min: Number(volume.global_min),
      max: Number(volume.global_max),
      preset: null
    }
  }
  return null
}
