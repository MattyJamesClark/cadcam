import type { CadModule } from '@/core/types'
import { homeModule } from './home'
import { plannedModules } from './planned'
import { viewModule } from './view'
import { queryModule } from './query'

/** Every tab in the app. Add new modules here. */
export const modules: CadModule[] = [homeModule, queryModule, viewModule, ...plannedModules]
