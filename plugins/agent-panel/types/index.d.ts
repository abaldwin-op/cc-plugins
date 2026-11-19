// The values this mod keeps in $.state (claude plugin validate checks every key the module names
// against this contract).
/** The `subagent.*` ids a row honors (and any other id, ignored). */
export type HideIds = string[]

declare module 'claude-code' {
  interface PluginState {
    'agent-panel': {
      /**
       * The `hide` ids (lowercased) from statusline-dashboard's config file, read at session start;
       * empty when the file is missing or broken.
       */
      hide: HideIds
    }
  }
}
