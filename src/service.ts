import express from 'express'
import bodyParser from 'body-parser'
import PushNotifications from './controllers/PushNotifications.js'
import { Types, Utils } from '@ikomida/shared-backend'

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
let { name } = require('../package.json')
name = name
  .replace(/^(@\S+\/)?(svelte-)?(\S+)/, '$3')
  .replace(/^\w/, (m: string) => m.toUpperCase())
  .replace(/-\w/g, (m: string[]) => m[1].toUpperCase())

const logger = Utils.Logger.getInstance(name)

const app = express()
app.disable('x-powered-by')
app.use(bodyParser.json({ limit: '10mb' }))
Utils.System.setExpressResponse(app)
const port = process?.env?.PORT || 80
const notifications = new PushNotifications(logger)

app.post('/notification/register', async (req, res) => {
  const identity: Types.Classes.CUser = Types.Classes.CUser.fromObject(req.headers?.identity)
  const payload = await notifications.register(identity, req.body)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.get('/vendor/pushNotifications/:timestamp', async (req, res) => {
  const identity: Types.Classes.CUser = Types.Classes.CUser.fromObject(req.headers?.identity)
  const payload = await notifications.getPushNotifications(identity, Number(req?.params?.timestamp))
  res.status(200).sendResponse(payload)
})

app.post('/vendor/pushNotification', async (req, res) => {
  const identity: Types.Classes.CUser = Types.Classes.CUser.fromObject(req.headers?.identity)
  const payload = await notifications.newPushNotification(identity, req.body)
  res.status(payload?.success ? 201 : 200).sendResponse(payload)
})

app.all('*', async (req, res) => {
  logger.error(`pushNotification endpoint "${req?.url}" not found:`)
  res.status(404).sendResponse({ error: 'NOT FOUND' })
})

app.listen(port, () => {
  logger.info(`${name} listening at http://localhost:${port}`)
})
