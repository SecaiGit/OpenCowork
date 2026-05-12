import type { BuiltinProviderPreset } from './types'

export const minimaxCodingPreset: BuiltinProviderPreset = {
  builtinId: 'minimax-coding',
  name: 'MiniMax（套餐）',
  type: 'anthropic',
  defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
  homepage: 'https://platform.minimaxi.com/subscribe/coding-plan',
  apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  defaultEnabled: false,
  defaultModel: 'MiniMax-M2.7',
  defaultModels: [
    // Coding Plan models (official docs: same Anthropic endpoint, dedicated Coding Plan key)
    {
      id: 'MiniMax-M2.7',
      name: 'MiniMax M2.7',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true
    },
    {
      id: 'MiniMax-M2.7-highspeed',
      name: 'MiniMax M2.7 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true
    },
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax M2.5',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true
    },
    {
      id: 'MiniMax-M2.5-highspeed',
      name: 'MiniMax M2.5 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true
    },
    {
      id: 'MiniMax-M2.1',
      name: 'MiniMax M2.1',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 64_000,
      supportsFunctionCall: true
    },
    {
      id: 'MiniMax-M2',
      name: 'MiniMax M2',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true
    }
  ]
}

export const minimaxPreset: BuiltinProviderPreset = {
  builtinId: 'minimax',
  name: 'MiniMax（官方）',
  type: 'anthropic',
  defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
  homepage: 'https://www.minimaxi.com',
  apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  defaultModel: 'MiniMax-M2.7',
  defaultModels: [
    // USD pricing references: https://platform.minimax.io/docs/guides/pricing-paygo
    {
      id: 'MiniMax-M2.7',
      name: 'MiniMax M2.7',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      cacheHitPrice: 0.06,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2.7-highspeed',
      name: 'MiniMax M2.7 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.4,
      cacheHitPrice: 0.06,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2.5',
      name: 'MiniMax M2.5',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2.5-highspeed',
      name: 'MiniMax M2.5 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.4,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2.1',
      name: 'MiniMax M2.1',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 64_000,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2.1-highspeed',
      name: 'MiniMax M2.1 Highspeed',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 64_000,
      supportsFunctionCall: true,
      inputPrice: 0.6,
      outputPrice: 2.4,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.375
    },
    {
      id: 'MiniMax-M2',
      name: 'MiniMax M2',
      icon: 'minimax',
      enabled: true,
      contextLength: 204_800,
      maxOutputTokens: 131_072,
      supportsFunctionCall: true,
      inputPrice: 0.3,
      outputPrice: 1.2,
      cacheHitPrice: 0.03,
      cacheCreationPrice: 0.375
    }
  ]
}
