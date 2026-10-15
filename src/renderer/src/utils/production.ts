import type { Connection } from '@shared/types'

/**
 * Production guard: connections marked `production` never run code without the user saying so. A run the user
 * started (Run, Run selection, the Run button, a re-run after the watched file changed) asks first; auto-evaluate
 * is blocked, since a confirm dialog on every pause in typing would be worse than not running. Background reads
 * (autocompletion, panels, logs) do not go through this.
 */

/** What started a run: the user, auto-evaluate while typing, or a change of the watched file. */
export type RunTrigger = 'manual' | 'auto' | 'watch'

export type ProductionGuard = 'run' | 'confirm' | 'block'

export function productionGuard(conn: Pick<Connection, 'production'> | null | undefined, trigger: RunTrigger): ProductionGuard {
  if (conn?.production !== true) return 'run'
  return trigger === 'auto' ? 'block' : 'confirm'
}

export function needsProductionConfirm(conn: Pick<Connection, 'production'> | null | undefined, trigger: RunTrigger): boolean {
  return productionGuard(conn, trigger) === 'confirm'
}
