import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://yoxhbtaqvccayqiqzmrv.supabase.co'
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlveGhidGFxdmNjYXlxaXF6bXJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA1MjYsImV4cCI6MjA4NjQzNjUyNn0.kyvZseHNpVFSALHcrs2vMnPtYfkA-AxDCq8QMCzGGRs'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
