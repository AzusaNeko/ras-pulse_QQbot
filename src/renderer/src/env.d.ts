/// <reference types="vite/client" />

import type { MercariPulseApi } from '../../shared/types'

declare global {
  interface Window {
    mercariPulse: MercariPulseApi
  }
}

export {}
