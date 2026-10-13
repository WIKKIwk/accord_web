import { describe, expect, it } from 'vitest'
import type { SettingsInput } from '@/lib/api'
import { backupInProgress, backupSource, backupStatus, runtimePercent, settingsUpdate, settingsValidation, verifiedBackupCount } from './SystemPages'

const settings: SettingsInput = {
  default_target_warehouse: 'Warehouse A', default_uom: 'Kg',
  werka_name: 'Ombor mas’uli', werka_phone: '+998901234567',
  admin_name: 'Administrator', admin_phone: '+998901111111',
}

describe('settings page mobile contract', () => {
  it('edits warehouse, unit and werka fields while preserving administrator identity', () => {
    expect(settingsUpdate(settings, {
      ...settings, default_target_warehouse: ' Warehouse B ', default_uom: ' kg ',
      werka_name: ' Updated ', werka_phone: ' +998902222222 ',
      admin_name: 'Stale or edited identity', admin_phone: '+998903333333',
    })).toEqual({
      default_target_warehouse: 'Warehouse B', default_uom: 'kg',
      werka_name: 'Updated', werka_phone: '+998902222222',
      admin_name: settings.admin_name, admin_phone: settings.admin_phone,
    })
  })

  it('allows the backend default unit and optional werka identity without invented required fields', () => {
    const empty = settingsUpdate(settings, { ...settings, default_uom: ' ', werka_name: '', werka_phone: '' })
    expect(empty.default_uom).toBe('')
    expect(settingsValidation(empty)).toBe('')
    expect(settingsValidation({ ...settings, werka_name: '' })).toBe('')
    expect(settingsValidation({ ...settings, werka_phone: '' })).toBe('')
  })

  it.each(['901234567', '+998901234567', '+998 (90) 123-45-67'])('accepts a phone allowed by backend normalization: %s', (phone) => {
    expect(settingsValidation({ ...settings, werka_phone: phone })).toBe('')
  })

  it.each(['1234567', '+1234567890123', '+99890abcdefg'])('rejects a phone rejected by backend normalization: %s', (phone) => {
    expect(settingsValidation({ ...settings, werka_phone: phone })).not.toBe('')
  })
})

describe('server monitor backup contract', () => {
  it('maps the actual backend status vocabulary', () => {
    expect(['queued', 'running', 'verifying', 'ready', 'failed'].map(backupStatus))
      .toEqual(['Navbatda', 'Tayyorlanmoqda', 'Tekshirilmoqda', 'Tayyor', 'Xatolik'])
    expect(backupStatus('completed')).toBe('Noma’lum')
  })

  it('maps the actual mobile and backend source vocabulary', () => {
    expect(['automatic', 'manual', 'legacy', 'imported', 'pre_restore'].map(backupSource))
      .toEqual(['Avtomatik', 'Qo‘lda', 'Oldingi nusxa', 'Import qilingan', 'Tiklashdan oldin'])
    expect(backupSource('scheduled')).toBe('Noma’lum')
  })

  it('uses server snapshot_count instead of counting failed and running snapshots as saved copies', () => {
    const snapshots = [
      { status: 'ready', verified: true }, { status: 'failed', verified: false },
      { status: 'running', verified: false }, { status: 'ready', verified: false },
    ]
    expect(verifiedBackupCount({ snapshot_count: 1, snapshots })).toBe(1)
    expect(verifiedBackupCount({ snapshot_count: 0, snapshots })).toBe(0)
    expect(verifiedBackupCount({ snapshots })).toBe(1)
    expect(verifiedBackupCount({})).toBe(0)
  })

  it('does not present a terminal active_job as a backup still being generated', () => {
    expect(backupInProgress({ id: 'backup-1', status: 'verifying' })).toBe(true)
    expect(backupInProgress({ id: 'backup-1', status: 'queued' })).toBe(true)
    expect(backupInProgress({ id: 'backup-1', status: 'ready' })).toBe(false)
    expect(backupInProgress({ id: 'backup-1', status: 'failed' })).toBe(false)
    expect(backupInProgress({})).toBe(false)
  })
})

describe('server runtime availability', () => {
  it('treats backend memory/disk total-zero fallback as unavailable while preserving actual zero usage', () => {
    expect(runtimePercent({ memory_total_mb: 0, memory_percent: 0 }, 'memory')).toBeNull()
    expect(runtimePercent({ disk_total_mb: 0, disk_percent: 0 }, 'disk')).toBeNull()
    expect(runtimePercent({ memory_total_mb: 1024, memory_percent: 0 }, 'memory')).toBe(0)
    expect(runtimePercent({ disk_total_mb: 51200, disk_percent: 24 }, 'disk')).toBe(24)
  })

  it('does not invent zero or clamp invalid percentages into apparently valid metrics', () => {
    expect(runtimePercent({}, 'cpu')).toBeNull()
    expect(runtimePercent({ cpu_percent: 18 }, 'cpu')).toBe(18)
    expect(runtimePercent({ cpu_percent: -1 }, 'cpu')).toBeNull()
    expect(runtimePercent({ cpu_percent: 101 }, 'cpu')).toBeNull()
  })
})
