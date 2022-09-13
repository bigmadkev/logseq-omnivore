import '@logseq/libs'
import {
  BlockEntity,
  IBatchBlock,
  LSPluginBaseInfo,
  SettingSchemaDesc,
} from '@logseq/libs/dist/LSPlugin'
import { getDateForPage } from 'logseq-dateutils'
import {
  Article,
  compareHighlightsInFile,
  getHighlightLocation,
  loadArticles,
  markdownEscape,
  PageType,
} from './util'
import { DateTime } from 'luxon'

enum Filter {
  ALL = 'import all my articles',
  HIGHLIGHTS = 'import just highlights',
  ADVANCED = 'advanced',
}

enum HighlightOrder {
  LOCATION = 'the location of highlights in the article',
  TIME = 'the time that highlights are updated',
}

interface Settings {
  apiKey: string
  filter: Filter
  syncAt: string
  frequency: number
  graph: string
  customQuery: string
  disabled: boolean
  highlightOrder: HighlightOrder
}

const siteNameFromUrl = (originalArticleUrl: string): string => {
  try {
    return new URL(originalArticleUrl).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const delay = (t = 100) => new Promise((r) => setTimeout(r, t))
const DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss"
let loading = false

const getQueryFromFilter = (filter: Filter, customQuery: string): string => {
  switch (filter) {
    case Filter.ALL:
      return ''
    case Filter.HIGHLIGHTS:
      return `has:highlights`
    case Filter.ADVANCED:
      return customQuery
    default:
      return ''
  }
}

const fetchOmnivore = async (inBackground = false) => {
  if (loading) return

  const { syncAt, apiKey, filter, customQuery, highlightOrder } =
    logseq.settings as Settings

  if (!apiKey) {
    await logseq.UI.showMsg('Missing Omnivore api key', 'warning')

    return
  }

  const pageName = 'Omnivore'
  const blockTitle = '## 🔖 Articles'
  const fetchingTitle = '🚀 Fetching articles ...'

  !inBackground && logseq.App.pushState('page', { name: pageName })

  await delay(300)

  loading = true
  let targetBlock: BlockEntity | null = null
  const userConfigs = await logseq.App.getUserConfigs()
  const preferredDateFormat: string = userConfigs.preferredDateFormat

  try {
    !inBackground && (await logseq.UI.showMsg('🚀 Fetching articles ...'))

    let omnivorePage = await logseq.Editor.getPage(pageName)
    if (!omnivorePage) {
      omnivorePage = await logseq.Editor.createPage(pageName)
    }
    if (!omnivorePage) {
      throw new Error('Failed to create page')
    }

    const pageBlocksTree = await logseq.Editor.getPageBlocksTree(pageName)
    targetBlock = pageBlocksTree.length > 0 ? pageBlocksTree[0] : null
    if (targetBlock) {
      await logseq.Editor.updateBlock(targetBlock.uuid, fetchingTitle)
    } else {
      targetBlock = await logseq.Editor.appendBlockInPage(
        pageName,
        fetchingTitle
      )
    }
    if (!targetBlock) {
      throw new Error('block error')
    }

    const size = 50
    for (
      let hasNextPage = true, articles: Article[] = [], after = 0;
      hasNextPage;
      after += size
    ) {
      ;[articles, hasNextPage] = await loadArticles(
        apiKey,
        after,
        size,
        DateTime.fromFormat(syncAt, DATE_FORMAT).toISO(),
        getQueryFromFilter(filter, customQuery)
      )

      const articleBatch: IBatchBlock[] = []
      for (const article of articles) {
        // Build content string
        let content = `[${article.title}](https://omnivore.app/me/${article.slug})`
        content += '\ncollapsed:: true'

        const displaySiteName =
          article.siteName || siteNameFromUrl(article.originalArticleUrl)
        if (displaySiteName) {
          content += `\nsite:: [${displaySiteName}](${article.originalArticleUrl})`
        }

        if (article.author) {
          content += `\nauthor:: ${article.author}`
        }

        if (article.labels && article.labels.length > 0) {
          content += `\nlabels:: ${article.labels
            .map((l) => `[[${l.name}]]`)
            .join()}`
        }

        content += `\ndate_saved:: ${getDateForPage(
          new Date(article.savedAt),
          preferredDateFormat
        )}`

        // sort highlights by location if selected in options
        highlightOrder === HighlightOrder.LOCATION &&
          article.highlights?.sort((a, b) => {
            try {
              if (article.pageType === PageType.File) {
                // sort by location in file
                return compareHighlightsInFile(a, b)
              }
              // for web page, sort by location in the page
              return (
                getHighlightLocation(a.patch) - getHighlightLocation(b.patch)
              )
            } catch (e) {
              console.error(e)
              return compareHighlightsInFile(a, b)
            }
          })
        const highlightBatch: IBatchBlock[] =
          article.highlights?.map((it) => {
            const noteChild = it.annotation
              ? { content: it.annotation }
              : undefined
            return {
              content: `>> ${it.quote} [⤴️](https://omnivore.app/me/${article.slug}#${it.id})`,
              children: noteChild ? [noteChild] : undefined,
              properties: { id: it.id },
            }
          }) || []

        let isNewArticle = true
        // update existing block if article is already in the page
        const existingBlocks = await logseq.DB.q<BlockEntity>(
          `"${article.slug}"`
        )
        if (existingBlocks && existingBlocks.length > 0) {
          isNewArticle = false
          // update existing block
          await logseq.Editor.updateBlock(existingBlocks[0].uuid, content)
          if (highlightBatch.length > 0) {
            // append highlights to existing block
            for (const highlight of highlightBatch) {
              const existingHighlights = await logseq.DB.q<BlockEntity>(
                `"${highlight.properties?.id as string}"`
              )
              if (existingHighlights && existingHighlights.length > 0) {
                // update existing highlight
                await logseq.Editor.updateBlock(
                  existingHighlights[0].uuid,
                  highlight.content
                )
                const noteChild = highlight.children?.[0]
                if (noteChild) {
                  const existingNotes = await logseq.DB.q<BlockEntity>(
                    `"${noteChild.content}"`
                  )
                  if (existingNotes && existingNotes.length > 0) {
                    // update existing note
                    await logseq.Editor.updateBlock(
                      existingNotes[0].uuid,
                      noteChild.content
                    )
                  } else {
                    // append new note
                    await logseq.Editor.insertBlock(
                      existingHighlights[0].uuid,
                      noteChild.content,
                      { sibling: false }
                    )
                  }
                }
              } else {
                // append new highlight
                await logseq.Editor.insertBatchBlock(
                  existingBlocks[0].uuid,
                  highlight,
                  { sibling: false }
                )
              }
            }
          }
        }

        isNewArticle &&
          articleBatch.unshift({
            content,
            children: highlightBatch,
          })
      }

      articleBatch.length > 0 &&
        (await logseq.Editor.insertBatchBlock(targetBlock.uuid, articleBatch, {
          before: true,
          sibling: false,
        }))
    }

    !inBackground && (await logseq.UI.showMsg('🔖 Articles fetched'))
    logseq.updateSettings({ syncAt: DateTime.local().toFormat(DATE_FORMAT) })
  } catch (e) {
    !inBackground &&
      (await logseq.UI.showMsg('Failed to fetch articles', 'warning'))
    console.error(e)
  } finally {
    loading = false
    targetBlock &&
      (await logseq.Editor.updateBlock(targetBlock.uuid, blockTitle))
  }
}

const syncOmnivore = (): number => {
  const settings = logseq.settings as Settings

  let intervalID = 0
  // sync every frequency minutes
  if (settings.frequency > 0) {
    intervalID = setInterval(
      async () => {
        if ((await logseq.App.getCurrentGraph())?.name === settings.graph) {
          await fetchOmnivore(true)
        }
      },
      settings.frequency * 1000 * 60,
      settings.syncAt
    )
  }

  return intervalID
}

/**
 * main entry
 * @param baseInfo
 */
const main = async (baseInfo: LSPluginBaseInfo) => {
  console.log('logseq-omnivore loaded')

  const settingsSchema: SettingSchemaDesc[] = [
    {
      key: 'apiKey',
      type: 'string',
      title: 'Enter your Omnivore Api Key',
      description:
        'You can create an API key at https://omnivore.app/settings/api',
      default: logseq.settings?.['api key'] as string,
    },
    {
      key: 'filter',
      type: 'enum',
      title: 'Select an Omnivore search filter type',
      description: 'Select an Omnivore search filter type',
      default: Filter.HIGHLIGHTS.toString(),
      enumPicker: 'select',
      enumChoices: Object.values(Filter),
    },
    {
      key: 'customQuery',
      type: 'string',
      title:
        'Enter an Omnivore custom search query if advanced filter is selected',
      description:
        'See https://omnivore.app/help/search for more info on search query syntax',
      default: '',
    },
    {
      key: 'frequency',
      type: 'number',
      title: 'Enter sync with Omnivore frequency',
      description:
        'Enter sync with Omnivore frequency in minutes here or 0 to disable',
      default: 60,
    },
    {
      key: 'graph',
      type: 'string',
      title: 'Enter the graph to sync with Omnivore',
      description: 'Enter the graph to sync Omnivore articles to',
      // default is the current graph
      default: (await logseq.App.getCurrentGraph())?.name as string,
    },
    {
      key: 'syncAt',
      type: 'string',
      title: 'Last Sync',
      description:
        'The last time Omnivore was synced. Clear this value to completely refresh the sync.',
      default: DateTime.fromISO(logseq.settings?.['synced at'] as string)
        .toLocal()
        .toFormat(DATE_FORMAT),
      inputAs: 'datetime-local',
    },
    {
      key: 'highlightOrder',
      type: 'enum',
      title: 'Order of Highlights',
      description: 'Select a way to sort new highlights in your articles',
      default: HighlightOrder.TIME.toString(),
      enumPicker: 'select',
      enumChoices: Object.values(HighlightOrder),
    },
  ]
  logseq.useSettingsSchema(settingsSchema)

  let frequency = logseq.settings?.frequency as number
  let intervalID: number

  logseq.onSettingsChanged(() => {
    const settings = logseq.settings as Settings
    const newFrequency = settings.frequency
    if (newFrequency !== frequency) {
      // remove existing scheduled task and create new one
      if (intervalID) {
        clearInterval(intervalID)
      }
      if (newFrequency > 0) {
        intervalID = syncOmnivore()
      }
      frequency = newFrequency
    }
  })

  logseq.provideModel({
    async loadOmnivore() {
      await fetchOmnivore()
    },
  })

  logseq.App.registerUIItem('toolbar', {
    key: 'logseq-omnivore',
    template: `
      <a data-on-click="loadOmnivore" class="button">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <g clip-path="url(#clip0_3843_101374)">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M14.9932 0.0384085C24.2849 -0.580762 32.0905 6.35808 32.2144 15.6498C32.2144 16.6404 31.9667 17.8788 31.719 18.9933C31.0999 21.7176 28.6232 23.5752 25.8947 23.5752H25.7709C22.4273 23.5752 20.1942 20.727 20.1942 17.627V14.1596L18.2129 17.1316L18.089 17.2555C16.9745 18.2462 15.3647 18.2462 14.2502 17.2555L14.0025 17.1316L11.8973 14.0358V22.0891H9.04913V12.426C9.04913 10.4446 11.402 9.20626 13.0118 10.6923L13.1357 10.8161L15.9838 15.0265L18.9559 10.9399L19.0797 10.8161C20.5657 9.57777 23.0424 10.5684 23.0424 12.6736V17.6311C23.0424 19.4886 24.1569 20.727 25.7667 20.727H25.8906C27.3766 20.727 28.6149 19.7363 28.9864 18.3741C29.2341 17.2596 29.3579 16.3928 29.3579 15.6498C29.3579 8.09176 22.9144 2.39538 15.2367 2.89072C8.66938 3.26222 3.34451 8.59122 2.84917 15.0306C2.35383 22.7124 8.42584 29.1518 15.9797 29.1518V32C6.68803 32 -0.622312 24.1943 -0.00314176 14.9026C0.620157 6.97725 6.93983 0.533745 14.9932 0.0384085Z" fill="rgb(67, 63, 56)"/>
          </g>
          <defs>
            <clipPath id="clip0_3843_101374">
              <rect width="32" height="32" fill="white"/>
            </clipPath>
          </defs>
        </svg>
      </a>
    `,
  })

  logseq.provideStyle(`
    [data-injected-ui=logseq-omnivore-${baseInfo.id}] {
      display: flex;
      align-items: center;
    }
  `)

  // fetch articles on startup
  await fetchOmnivore(true)

  // sync every frequency minutes
  intervalID = syncOmnivore()
}

// bootstrap
logseq.ready(main).catch(console.error)
