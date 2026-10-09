import type { ProviderCapabilities } from '../../core/providers/types';

export const DSH_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'dsh',
  supportsNativeHistory: true,
  supportsPlanMode: true,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: false,
  // The DSH bridge negotiates image prompts per connection and the harness
  // rejects them for text-only routes, so the paste path stays enabled and the
  // bridge is the authority on whether a given model accepts the image.
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  reasoningControl: 'effort',
});
