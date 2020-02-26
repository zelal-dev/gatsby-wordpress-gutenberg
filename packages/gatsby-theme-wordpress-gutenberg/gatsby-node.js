const { default: pluck } = require(`graphql-tag-pluck`)
const { parse, Kind } = require(`graphql`)
const path = require(`path`)
const fs = require(`fs-extra`)
const { pascalize } = require(`humps`)
const chokidar = require(`chokidar`)

const PLUGIN_NAME = require(`./package.json`).name
const BLOCKS_PATH = path.join(`src`, PLUGIN_NAME, `blocks`)
const PREVIEW_BLOCKS_PATH = path.join(`src`, PLUGIN_NAME, `preview-blocks`)
const PAGES_PATH = path.join(`src`, PLUGIN_NAME, `pages`)

let watcher

const fragments = {
  GutenbergPostBlock: `
  fragment GutenbergPostBlock on GutenbergBlock {
    name
    id
  }
`,
}

const linkToTypename = ({ link }) => pascalize(new URL(link).pathname.replace(/(^\/|\/$)/g, ``))

const fetchPostIds = async ({ graphql }) => {
  const { data, errors } = await graphql(`
    query {
      allGutenbergContent {
        edges {
          node {
            postId
          }
        }
      }
    }
  `)

  if (errors) {
    throw errors[0]
  }

  return Array.from(new Set(data.allGutenbergContent.edges.map(({ node }) => node.postId)))
}

const fetchLatest = async ({ graphql, postId, preview }) => {
  //   const filters = [`postId: {eq: ${postId}}`]

  //   if (!preview) {
  //     filters.push(`isPreview: {eq: false}`, `link: {ne: null}`)
  //   }

  //   const query = `
  // ${fragments.GutenbergPostBlock}
  // query {
  //   allGutenbergContent(sort: {fields: [modifiedTime], order: [DESC]}, filter: {${filters.join(`, `)}}) {
  //     edges {
  //       node {
  //         id
  //         postId
  //         link
  //         modifiedTime
  //         isPreview
  //         blocks {
  //           __typename
  //           ...GutenbergPostBlock
  //           innerBlocks {
  //             __typename
  //             ...GutenbergPostBlock
  //           }
  //         }
  //       }
  //     }
  //   }
  // }
  // `

  // return (data.allGutenbergContent.edges.length && data.allGutenbergContent.edges[0].node) || null

  const { data, errors } = await graphql(`
    ${fragments.GutenbergPostBlock}
    query {
      allGutenbergContent(sort: { fields: [postId, modifiedTime], order: [ASC, DESC] }) {
        edges {
          node {
            id
            postId
            link
            slug
            parent {
              typename: __typename
            }
            modifiedTime
            isPreview
            blocks {
              __typename
              ...GutenbergPostBlock
              innerBlocks {
                __typename
                ...GutenbergPostBlock
              }
            }
          }
        }
      }
    }
  `)

  if (errors) {
    throw errors[0]
  }

  for (const edge of data.allGutenbergContent.edges) {
    const { node } = edge

    if (node.postId === postId) {
      if (preview) {
        return node
      } else if (node.link && !node.isPreview) {
        return node
      }
    }
  }

  return null
}

const fetchInnerBlocks = async ({ graphql, block: { __typename, id } }) => {
  const field = __typename.charAt(0).toLowerCase() + __typename.slice(1)

  const { data, errors } = await graphql(`
    ${fragments.GutenbergPostBlock}
    query {
      ${field}(id: {eq: "${id}"}) {
        innerBlocks {
          __typename
          ...GutenbergPostBlock
        }
      }
    }
  `)

  if (errors) {
    throw errors[0]
  }

  return data[field]
}

// creates fragment sdl for all blocks/innerBlocks
const createFragment = ({ name, blockFragmentNames, innerBlocksLevel }) => {
  const spreads = blockFragmentNames.map(blockFragmentName => `...${blockFragmentName}`).join(` `)

  // since we cannot create recursive fragment definition,
  // we have to statically analyse nesting count and generate proper fields selections
  const generate = (level = 0) => {
    let fragment =
      level === 0 ? `{ __typename id ${spreads} ` : ` innerBlocks { __typename ... on GutenbergBlock { id } ${spreads}`

    if (level < innerBlocksLevel) {
      fragment += generate(level + 1)
    }

    fragment += ` }`

    return fragment
  }

  return `fragment ${name} on GutenbergBlock ${generate()}`
}

// creates source code for <Blocks/> component
const createBlocksComponentSource = ({ blockTypenameByName, componentPathByName, sdl }) => `/* eslint-disable */
/* Warning: this file is autogerated, any changes would be lost */

import React from 'react'
import { graphql } from 'gatsby'

${Array.from(blockTypenameByName.entries())
  .map(([blockName, blockTypename]) => `import ${blockTypename} from '${componentPathByName.get(blockName)}'`)
  .join(`\n`)}

export const query = graphql\`${sdl}\`

const Blocks = ({blocks}) => {
  return (
    <>
      {blocks.map((block, i) => {  
        const children = block.innerBlocks ? <Blocks blocks={block.innerBlocks} /> : null;

        ${Array.from(blockTypenameByName.entries())
          .map(
            ([, blockTypename]) => `if (block.__typename === '${blockTypename}') {
            return <${blockTypename} {...block} children={children} key={block.id} />
          }`
          )
          .join(`\n        `)}
         
        return null;
      })}
    </>
  );
};

export default Blocks
`

// creates source code for page
const createPageComponentSource = ({
  preview,
  id,
  fragmentName,
  postId,
  componentPath,
  templateComponentPath,
  templateComponentFragmentName,
}) => `/* eslint-disable */
/* Warning: this file is autogerated, any changes would be lost */
import React from 'react'
import { graphql } from 'gatsby'
import Blocks from '${componentPath}'
import PageTemplate from '${templateComponentPath}'

export const pageQuery = graphql\`
  query GetGutenbergContent${preview ? `Preview` : ``}${postId}($postId: Int!) {
    gutenbergContent(id: {eq: "${id}"}, postId: {eq: $postId}) {
      blocks {
        ...${fragmentName}
      }
    }
    
    ${templateComponentFragmentName ? `...${templateComponentFragmentName}` : ``}
  }\`

const Page = props =>
  <PageTemplate {...props}>
    <Blocks blocks={props.data.gutenbergContent.blocks} />
  </PageTemplate>

export default Page
`

const linkToFilename = ({ link }) => {
  const pathname = new URL(link).pathname
  if (pathname === `/`) {
    return `index`
  }

  return pathname.replace(/\/$/, ``)
}

// extracts graphql sdl from graphql`` tag inside component file
const extractGraphql = async ({ componentPath }) => {
  try {
    const sdl = await pluck.fromFile(componentPath, {
      modules: [
        {
          name: `gatsby`,
          identifier: `graphql`,
        },
      ],
    })

    return parse(sdl)
  } catch (err) {
    return null
  }
}

// writes file to disk only on change/new file (avoids unnecessary rebuilds)
const writeFile = async ({ filePath, data }) => {
  const oldData = await fs.readFile(filePath, `utf-8`).catch(() => null)

  if (oldData !== data) {
    await fs.outputFile(filePath, data)
  }
}

// resolves component path which will be used in our generated sources
// uses same alghoritm as component shadowing so the component which
// is closest to the user's project in the template hierarchy wins
const resolveComponentPath = async ({ store, componentPath }) => {
  const extensions = store.getState().program.extensions
  const projectRoot = store.getState().program.directory

  // flattenedPlugins are already properly sorted accoridng to gatsby's template hierarchy
  // so the themes which use another themes are properly ordered
  const pluginPaths = store.getState().flattenedPlugins.map(flattenedPlugin => {
    if (flattenedPlugin.name === PLUGIN_NAME) {
      return path.join(flattenedPlugin.pluginFilepath, `src`)
    }

    return path.join(flattenedPlugin.pluginFilepath, `src`, `gatsby-theme-wordpress-gutenberg`)
  })

  // reverse reverses array in place, so we create a copy first
  const dirs = Array.from(new Set([projectRoot, ...[...pluginPaths].reverse()]))

  for (const dir of dirs) {
    const possiblePath = path.join(dir, componentPath)

    let exists = await fs.exists(possiblePath)

    if (exists) {
      return path
    }

    for (const extension of extensions) {
      const possiblePathWithExtension = `${possiblePath}${extension}`

      exists = await fs.exists(possiblePathWithExtension)
      if (exists) {
        return possiblePathWithExtension
      }
    }
  }

  return null
}

// resolves template component path which will be used in our generated sources as the page component
// uses same alghoritm as component shadowing so the component which
// is closest to the user's project in the template hierarchy wins
// more info on templates further down in comments
const resolveTemplateComponentPath = async ({ store, postId, link, typename, slug }) =>
  (await resolveComponentPath({ store, componentPath: path.join(`templates`, `by-id`, `${postId}`) })) ||
  (link &&
    (await resolveComponentPath({
      store,
      componentPath: path.join(`templates`, `by-link`, linkToFilename({ link })),
    }))) ||
  (typename &&
    slug &&
    (await resolveComponentPath({
      store,
      componentPath: path.join(`templates`, `by-type`, typename, slug),
    }))) ||
  (typename &&
    (await resolveComponentPath({
      store,
      componentPath: path.join(`templates`, `by-type`, typename, `index`),
    }))) ||
  (await resolveComponentPath({
    store,
    componentPath: path.join(`templates`, `index`),
  }))

const resolveUnknownComponentPath = options =>
  resolveComponentPath({
    ...options,
    componentPath: path.join(`components`, `unknown-block`),
  })

const resolveBlockComponentPath = async ({ blockName, unknownBlockComponentPath, ...options }) => {
  const possibleComponentPath = await resolveComponentPath({
    ...options,
    componentPath: path.join(`components`, `blocks`, blockName),
  })

  return possibleComponentPath || unknownBlockComponentPath
}

const resolveBlockFragment = async ({
  componentPath,
  // reporter
}) => {
  const document = await extractGraphql({ componentPath })

  if (document) {
    let fragment

    document.definitions.forEach(d => {
      if (d.kind === Kind.FRAGMENT_DEFINITION) {
        if (fragment) {
          throw new Error(`GraphQL Error: Component ${componentPath} must contain only one fragment definition`)
        }

        fragment = d
      }
    })

    return fragment
  }

  throw new Error(`Fragment definition in ${componentPath} not found`)
}

// processess all gutenberg content nodes and generates source files
// main philosophy (user only cares about block component implementation / all other things are auto-handled with choices to opt-out):
// - the <Blocks /> component is autogenerated from querying sourced data - this way you only import/query blocks which are used in post's content
// - the <Blocks /> component file contains fragment definition on all the blocks/innerBlocks used in that post
// - user / child theme can provide block component implemention, if not the default 'unknown-block.js' is used (uses dangerouslySetInnerHTML internally)
// - user / child theme can create block component implementation inside its
//   src/gatsby-theme-wordpress-gutenberg/components/blocks/[block-name] folder
//   eq: src/gatsby-theme-wordpress-gutenberg/components/blocks/core/paragraph.[js,tsx or any other configured extension in gatsby]
// - the created component file should contain fragment definition on the block graphql type which will be
//   automatically imported into the generated GutenbergBlocks[post-id] fragment and used
//   in the pageQuery in the generated page component file sources
// - user/child theme can create template component implementation (file used when creating gatsby's page component)
// - to override (shadow) the shipped template user can create files in its src/gatsby-source-wordpress-gutenberg/templates with following rules:
//    (Insipired by: https://wphierarchy.com/)
//    - index.js - override shipped main template for all posts
//    - by-id/[wordpress id].js - override template for post with id
//    - by-link/[wordpress link pathname].js - override template for post with link eq: blog/hello-world.js
//    - by-type/[gatsby's graphql typename]/[wordpress slug].js -- override template for typename with slug
//    - by-type/[gatsby's graphql typename]/index.js - override template for same typename

// - the created template component can contain fragment definition on root Query type which will be
//   automatically imported into the generated page query (useful to query post's YOAST seo/acf fields or all other gatsby's content)
//   the user can use graphql $id variable in the graphql string which is the wordpress id of the post (Int!)
// - template components gets the <Blocks /> component as its children prop
// - the page generation can be turned off completely, user can than import src/gatsby-theme-wordpress-gutenberg/blocks/by-id/[wordpress id].js
//   or src/gatsby-theme-wordpress-gutenberg/blocks/by-link/[wordpress link pathname].js file and
//   use the fragment GutenbergBlocks[postId] or GutenbergBlocks[linkPathname] in the page query manually
const processContent = async (options, pluginOptions) => {
  const { graphql, actions, store } = options

  const { program } = store.getState()
  const { createPage } = actions

  const postIds = await fetchPostIds({ graphql })

  if (postIds.length) {
    const componentPathByName = new Map()
    const fragmentNameByName = new Map()

    const unknownBlockComponentPath = await resolveUnknownComponentPath(options)

    const visitBlocks = async ({ blocks }) => {
      const blockTypenameByName = new Map()
      let innerBlocksLevel = 0

      const visitBlock = async ({ block }) => {
        const { name } = block
        blockTypenameByName.set(name, block.__typename)

        if (!componentPathByName.has(name)) {
          componentPathByName.set(
            name,
            await resolveBlockComponentPath({ blockName: name, unknownBlockComponentPath, ...options })
          )
        }

        if (!fragmentNameByName.has(name)) {
          const fragment = await resolveBlockFragment({ componentPath: componentPathByName.get(name) })
          fragmentNameByName.set(name, fragment.name.value)
        }
      }

      const visitInnerBlock = async ({ innerBlock, currentInnerBlocksLevel }) => {
        innerBlocksLevel = Math.max(currentInnerBlocksLevel, innerBlocksLevel)

        await visitBlock({ block: innerBlock })
        const { innerBlocks } = await fetchInnerBlocks({ graphql, block: innerBlock })

        await Promise.all(
          innerBlocks.map(async innerBlock => {
            await visitInnerBlock({ innerBlock, currentInnerBlocksLevel: currentInnerBlocksLevel + 1 })
          })
        )
      }

      await Promise.all(
        blocks.map(async block => {
          await visitBlock({ block })

          await Promise.all(
            block.innerBlocks.map(async innerBlock => {
              await visitInnerBlock({ innerBlock, currentInnerBlocksLevel: 1 })
            })
          )
        })
      )

      return { blockTypenameByName, innerBlocksLevel }
    }

    const processNode = async ({ node, preview }) => {
      const {
        postId,
        blocks,
        link,
        id,
        slug,
        parent: { typename },
      } = node

      const createBlocksComponent = async () => {
        const { innerBlocksLevel, blockTypenameByName } = await visitBlocks({ blocks })

        const blockFragmentNames = Array.from(blockTypenameByName.keys()).map(name => fragmentNameByName.get(name))
        const fragmentName = `${!preview ? `GutenbergBlocks` : `GutenbergPreviewBlocks`}${postId}`

        const componentPath = path.join(
          program.directory,
          !preview ? BLOCKS_PATH : PREVIEW_BLOCKS_PATH,
          `by-id`,
          `${postId}.js`
        )

        await writeFile({
          filePath: componentPath,
          data: createBlocksComponentSource({
            sdl: createFragment({
              name: fragmentName,
              blockFragmentNames,
              innerBlocksLevel,
            }),
            blockTypenameByName,
            componentPathByName,
          }),
        })

        if (link && !preview) {
          await writeFile({
            filePath: path.join(program.directory, BLOCKS_PATH, `by-link`, `${linkToFilename({ link })}.js`),
            data: createBlocksComponentSource({
              sdl: createFragment({
                name: `GutenbergBlocks${linkToTypename({
                  link,
                })}`,
                blockFragmentNames,
                innerBlocksLevel,
              }),
              blockTypenameByName,
              componentPathByName,
            }),
          })
        }

        return { fragmentName, componentPath }
      }

      const templateComponentPath = await resolveTemplateComponentPath({
        ...options,
        postId,
        link,
        typename,
        slug,
      })

      const document = await extractGraphql({ componentPath: templateComponentPath })

      let templateComponentFragment = null

      if (document) {
        document.definitions.forEach(d => {
          if (d.kind === Kind.FRAGMENT_DEFINITION) {
            if (templateComponentFragment || d.typeCondition.name.value !== `Query`) {
              throw new Error(
                `GraphQL Error: Template \`${templateComponentFragment}\` must contain only one fragment definition on Query type.`
              )
            }

            templateComponentFragment = d
          }
        })
      }

      const { fragmentName, componentPath } = await createBlocksComponent({
        blocks,
      })

      const pageComponentPath = path.join(program.directory, PAGES_PATH, preview ? `___gutenberg` : ``, `${postId}.js`)

      await writeFile({
        filePath: pageComponentPath,
        data: createPageComponentSource({
          postId,
          id,
          preview,
          fragmentName,
          componentPath,
          templateComponentPath,
          templateComponentFragmentName: templateComponentFragment && templateComponentFragment.name.value,
        }),
      })

      await createPage({
        component: pageComponentPath,
        path: preview ? `/___gutenberg/${postId}` : new URL(link).pathname,
        context: {
          postId,
        },
      })
    }

    await Promise.all(
      postIds.map(async postId => {
        const node = await fetchLatest({ graphql, postId })

        if (node) {
          await processNode({ node })
        }

        const previewNode = await fetchLatest({ graphql, postId, preview: true })

        if (previewNode) {
          await processNode({ node: previewNode, preview: true })
        }
      })
    )
  }
}

exports.onPreBootstrap = async options => {
  const { store } = options

  const {
    program: { directory },
  } = store.getState()

  // perform cleanup
  await Promise.all([
    fs.emptyDir(path.join(directory, BLOCKS_PATH)),
    fs.emptyDir(path.join(directory, PREVIEW_BLOCKS_PATH)),
    fs.emptyDir(path.join(directory, PAGES_PATH)),
  ])
}

exports.createPages = async (options, pluginOptions) => {
  await processContent(options, pluginOptions)
}

exports.createPagesStatefully = (options, pluginOptions) => {
  if (process.env.NODE_ENV === `development`) {
    if (watcher) {
      return
    }

    // to enhance developer experience we will track changes in all
    // child themes/root project's src/gatsby-theme-wordpress-gutenberg/{components/templates} and the theme itself
    // and regenerate source files upon change
    const { store, reporter } = options

    const program = store.getState().program
    const exts = program.extensions.map(e => `${e.slice(1)}`).join(`,`)

    const cb = () => {
      // if we are already running return
      if (cb.current) {
        return
      }
      reporter.info(`refreshing gutenberg pages`)
      cb.current = processContent(options, pluginOptions)
        .catch(err => {
          reporter.error(err)
        })
        .finally(() => {
          cb.current = null
        })
    }

    watcher = chokidar
      .watch(
        store.getState().flattenedPlugins.map(flattenedPlugin => {
          const directoryPath = flattenedPlugin.pluginFilepath
          return `${directoryPath}/${
            flattenedPlugin.name === PLUGIN_NAME ? `src/` : `src/gatsby-theme-wordpress-gutenberg/`
          }{components,templates}/**/*.{${exts}}`
        })
      )
      .on(`all`, cb)
  }
}
