import { useState } from 'react'
import { NAME_MAX, type Profile } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { RowMenu } from './RowMenu'

/**
 * The profiles, each with its own projects, chats and browser logins: added,
 * renamed, switched to and deleted here. It is the body of Settings' Profiles
 * row; the explanation sits above it.
 */
export function ProfilesBody({
  profiles,
  profileId
}: {
  profiles: Profile[]
  /** The profile the window shows. */
  profileId: string
}): React.JSX.Element {
  /** The profile being renamed, or 'new' while one is added. */
  const [editing, setEditing] = useState<string>()
  const [error, setError] = useState<string>()
  /** Deleting asks on the Mac; through the remote link there is no one there to answer. */
  const canDelete = !window.api.remote && profiles.length > 1

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <div className="provider-list">
        {profiles.map((profile) =>
          editing === profile.id ? (
            <ProfileForm
              key={profile.id}
              saved={profile.name}
              onSave={async (name) => {
                await window.api.profiles.rename(profile.id, name)
                setEditing(undefined)
              }}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <div className="provider-row" key={profile.id}>
              <div className="provider-row-text">
                <span className="provider-row-name">{profile.name}</span>
                {profile.id === profileId && <span className="provider-row-detail">In use</span>}
              </div>
              {profile.id !== profileId && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => act(() => window.api.profiles.switch(profile.id))}
                >
                  Switch
                </button>
              )}
              <RowMenu
                label={`${profile.name} options`}
                items={[
                  { name: 'Rename', onSelect: () => setEditing(profile.id) },
                  ...(canDelete
                    ? [
                        {
                          name: 'Delete',
                          danger: true,
                          onSelect: () => act(() => window.api.profiles.remove(profile.id))
                        }
                      ]
                    : [])
                ]}
              />
            </div>
          )
        )}
      </div>
      {editing === 'new' ? (
        <ProfileForm
          saved=""
          onSave={async (name) => {
            await window.api.profiles.add(name)
            setEditing(undefined)
          }}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <div className="settings-row">
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            Add profile
          </button>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/** A profile's name, to add one (saved empty) or rename one. */
function ProfileForm({
  saved,
  onSave,
  onCancel
}: {
  saved: string
  onSave: (name: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [name, setName] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      await onSave(name)
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  return (
    <>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || e.defaultPrevented) return
          // Handled: cancelling the form must not also leave Settings.
          e.preventDefault()
          onCancel()
        }}
      >
        <input
          autoFocus
          aria-label="Profile name"
          placeholder="Work"
          value={name}
          maxLength={NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn primary"
          disabled={saving || !name.trim() || name.trim() === saved}
        >
          {saved ? 'Save' : 'Add'}
        </button>
      </form>
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}
