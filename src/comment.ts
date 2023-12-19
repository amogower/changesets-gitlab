import { ValidationError } from '@changesets/errors'
import type {
  ComprehensiveRelease,
  ReleasePlan,
  VersionType,
} from '@changesets/types'
import type { Gitlab } from '@gitbeaker/core'
import type {
  DiscussionNoteSchema,
  DiscussionSchema,
  MergeRequestChangesSchema,
  MergeRequestNoteSchema,
  NoteSchema,
} from '@gitbeaker/rest'
import { captureException } from '@sentry/node'
import { humanId } from 'human-id'
import { markdownTable } from 'markdown-table'

import * as context from './context.js'
import { env } from './env.js'
import { getChangedPackages } from './get-changed-packages.js'
import type { LooseString } from './types.js'
import { getUsername } from './utils.js'

import { createApi } from './index.js'

const generatedByBotNote = 'Generated By Changesets GitLab Bot'

const getReleasePlanMessage = (releasePlan: ReleasePlan | null) => {
  if (!releasePlan) return ''

  const publishableReleases = releasePlan.releases.filter(
    (x): x is ComprehensiveRelease & { type: Exclude<VersionType, 'none'> } =>
      x.type !== 'none',
  )

  const table = markdownTable([
    ['Name', 'Type'],
    ...publishableReleases.map(x => [
      x.name,
      {
        major: 'Major',
        minor: 'Minor',
        patch: 'Patch',
      }[x.type],
    ]),
  ])

  return `<details><summary>This MR includes ${
    releasePlan.changesets.length > 0
      ? `changesets to release ${
          publishableReleases.length === 1
            ? '1 package'
            : `${publishableReleases.length} packages`
        }`
      : 'no changesets'
  }</summary>

  ${
    publishableReleases.length > 0
      ? table
      : "When changesets are added to this MR, you'll see the packages that this MR includes changesets for and the associated semver types"
  }

</details>`
}

const getAbsentMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null,
) => `###  ⚠️  No Changeset found

Latest commit: ${commitSha}

Merging this MR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

${getReleasePlanMessage(releasePlan)}

[Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add a changeset to this MR](${addChangesetUrl})

__${generatedByBotNote}__
`

const getApproveMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null,
) => `###  🦋  Changeset detected

Latest commit: ${commitSha}

**The changes in this MR will be included in the next version bump.**

${getReleasePlanMessage(releasePlan)}

Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add another changeset to this MR](${addChangesetUrl})

__${generatedByBotNote}__
`

const getNewChangesetTemplate = (changedPackages: string[], title: string) =>
  encodeURIComponent(`---
${changedPackages.map(x => `"${x}": patch`).join('\n')}
---

${title}
`)

const isMrNote = (
  discussionOrNote: DiscussionSchema | MergeRequestNoteSchema,
): discussionOrNote is MergeRequestNoteSchema =>
  'noteable_type' in discussionOrNote &&
  discussionOrNote.noteable_type === 'MergeRequest'

const RANDOM_BOT_NAME_PATTERN = /^((?:project|group)_\d+_bot\w*)_[\da-z]+$/i

const isChangesetBotNote = (
  note: DiscussionNoteSchema | NoteSchema,
  username: string,
  random?: boolean,
) =>
  (note.author.username === username ||
    (random &&
      note.author.username.match(RANDOM_BOT_NAME_PATTERN)?.[1] === username)) &&
  // We need to ensure the note is generated by us, but we don't have an app bot like GitHub
  // @see https://github.com/apps/changeset-bot
  note.body.includes(generatedByBotNote)

async function getNoteInfo(
  api: Gitlab,
  mrIid: number | string,
  commentType: LooseString<'discussion'>,
  random?: boolean,
): Promise<{ discussionId: string; noteId: number } | null | undefined>
async function getNoteInfo(
  api: Gitlab,
  mrIid: number | string,
  commentType: LooseString<'note'>,
  random?: boolean,
): Promise<{ noteId: number } | null | undefined>
async function getNoteInfo(
  api: Gitlab,
  mrIid: number | string,
  commentType: LooseString<'discussion' | 'note'>,
  random?: boolean,
): Promise<
  | { discussionId: string; noteId: number }
  | { noteId: number }
  | null
  | undefined
> {
  const discussionOrNotes = await (commentType === 'discussion'
    ? api.MergeRequestDiscussions.all(context.projectId, mrIid)
    : api.MergeRequestNotes.all(context.projectId, +mrIid))

  const username = await getUsername(api)

  for (const discussionOrNote of discussionOrNotes) {
    if (isMrNote(discussionOrNote)) {
      if (isChangesetBotNote(discussionOrNote, username, random)) {
        return {
          noteId: discussionOrNote.id,
        }
      }
      continue
    }

    if (!discussionOrNote.notes) {
      continue
    }

    const changesetBotNote = discussionOrNote.notes.find(note =>
      isChangesetBotNote(note, username),
    )

    if (changesetBotNote) {
      return {
        discussionId: discussionOrNote.id,
        noteId: changesetBotNote.id,
      }
    }
  }

  /**
   * The `username` used for commenting could be random, if we haven't tested the random `username`, then test it
   *
   * @see https://docs.gitlab.com/ee/development/internal_users.html
   * @see https://github.com/un-ts/changesets-gitlab/issues/145#issuecomment-1860610958
   */
  return random ? null : getNoteInfo(api, mrIid, commentType, true)
}

const hasChangesetBeenAdded = async (
  changedFilesPromise: Promise<MergeRequestChangesSchema>,
) => {
  const changedFiles = await changedFilesPromise
  return changedFiles.changes.some(file => {
    return (
      file.new_file &&
      /^\.changeset\/.+\.md$/.test(file.new_path) &&
      file.new_path !== '.changeset/README.md'
    )
  })
}

/**
 * @see https://github.com/jdalrymple/gitbeaker/blob/52ef0e622de304d98afb811f4937560edefd8889/packages/rest/src/Requester.ts#L79-L86
 */
export interface GitLabAPIError extends Error {
  cause: {
    description: string
    request: Request
    response: Response
  }
}

const GITLAB_API_ERROR_CAUSE_KEYS = new Set([
  'description',
  'request',
  'response',
])

// eslint-disable-next-line @typescript-eslint/unbound-method
const { toString } = Object.prototype

const isError = (value: unknown): value is Error =>
  toString.call(value) === '[object Error]'

const isGitLabAPIError = (error: unknown): error is GitLabAPIError =>
  isError(error) &&
  !!error.cause &&
  typeof error.cause === 'object' &&
  Object.keys(error.cause).every(key => GITLAB_API_ERROR_CAUSE_KEYS.has(key))

// eslint-disable-next-line sonarjs/cognitive-complexity
export const comment = async () => {
  const mrBranch = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
  if (!mrBranch) {
    console.warn('[changesets-gitlab:comment] It should only be used on MR')
    return
  }

  const {
    CI_MERGE_REQUEST_IID: mrIid,
    CI_MERGE_REQUEST_PROJECT_URL,
    CI_MERGE_REQUEST_SOURCE_BRANCH_SHA,
    CI_MERGE_REQUEST_TITLE,
    GITLAB_COMMENT_TYPE,
    GITLAB_ADD_CHANGESET_MESSAGE,
  } = env

  if (mrBranch.startsWith('changeset-release')) {
    return
  }

  const api = createApi()

  let errFromFetchingChangedFiles = ''
  try {
    const latestCommitSha = CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
    const changedFilesPromise = api.MergeRequests.showChanges(
      context.projectId,
      mrIid,
    )

    const [noteInfo, hasChangeset, { changedPackages, releasePlan }] =
      await Promise.all([
        getNoteInfo(api, mrIid, GITLAB_COMMENT_TYPE),
        hasChangesetBeenAdded(changedFilesPromise),
        getChangedPackages({
          changedFiles: changedFilesPromise.then(x =>
            x.changes.map(x => x.new_path),
          ),
          api,
        }).catch((err: unknown) => {
          if (err instanceof ValidationError) {
            errFromFetchingChangedFiles = `<details><summary>💥 An error occurred when fetching the changed packages and changesets in this MR</summary>\n\n\`\`\`\n${err.message}\n\`\`\`\n\n</details>\n`
          } else {
            console.error(err)
            captureException(err)
          }
          return {
            changedPackages: ['@fake-scope/fake-pkg'],
            releasePlan: null,
          }
        }),
      ] as const)

    const addChangesetUrl = `${CI_MERGE_REQUEST_PROJECT_URL}/-/new/${mrBranch}?file_name=.changeset/${humanId(
      {
        separator: '-',
        capitalize: false,
      },
    )}.md&file=${getNewChangesetTemplate(
      changedPackages,
      CI_MERGE_REQUEST_TITLE,
    )}${
      GITLAB_ADD_CHANGESET_MESSAGE
        ? '&commit_message=' + encodeURIComponent(GITLAB_ADD_CHANGESET_MESSAGE)
        : ''
    }`

    const prComment =
      (hasChangeset
        ? getApproveMessage(latestCommitSha, addChangesetUrl, releasePlan)
        : getAbsentMessage(latestCommitSha, addChangesetUrl, releasePlan)) +
      errFromFetchingChangedFiles

    switch (GITLAB_COMMENT_TYPE) {
      case 'discussion': {
        if (noteInfo) {
          return api.MergeRequestDiscussions.editNote(
            context.projectId,
            mrIid,
            noteInfo.discussionId,
            noteInfo.noteId,
            {
              body: prComment,
            },
          )
        }

        return api.MergeRequestDiscussions.create(
          context.projectId,
          mrIid,
          prComment,
        )
      }
      case 'note': {
        if (noteInfo) {
          return api.MergeRequestNotes.edit(
            context.projectId,
            mrIid,
            noteInfo.noteId,
            { body: prComment },
          )
        }

        return api.MergeRequestNotes.create(context.projectId, mrIid, prComment)
      }
      default: {
        throw new Error(
          `Invalid comment type "${GITLAB_COMMENT_TYPE}", should be "discussion" or "note"`,
        )
      }
    }
  } catch (err: unknown) {
    if (isGitLabAPIError(err)) {
      const {
        cause: { description, request, response },
      } = err
      console.error(description)
      try {
        console.error('request:', await request.text())
      } catch {
        console.error("The error's request could not be used as plain text")
      }
      try {
        console.error('response:', await response.text())
      } catch {
        console.error("The error's response could not be used as plain text")
      }
    }
    throw err
  }
}
