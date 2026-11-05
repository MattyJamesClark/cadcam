import type { CadModule } from '@/core/types'
import { homeModule } from './home'
import { plannedModules } from './planned'
import { viewModule } from './view'

/** Every tab in the app. Add new modules here. */
export const modules: CadModule[] = [homeModule, viewModule, ...plannedModules]
