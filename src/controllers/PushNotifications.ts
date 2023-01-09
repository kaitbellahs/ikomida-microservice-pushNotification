import { Domain, Utils, DBModels, objHasProp } from '@ikomida/shared-backend'
import { Finances } from '@ikomida/shared-logics'
import { Classes, Types } from '@ikomida/shared-types'
import { Includeable } from 'sequelize'

export default class PushNotifications {
  limit = 10
  logger
  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async register(input: any, iKomidaId?: string, agent?: string, deviceId?: string, identity?: Classes.CUser) {
    let transaction: Domain.SqlDB.Transaction | undefined = undefined
    const payload: Classes.CRegisterPushNotification = Classes.CRegisterPushNotification.fromObject(input)
    try {
      if (!payload.validate() || !this.validateObject(payload) || !agent || (!identity?.ikomidaID && !iKomidaId)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_MISSING_DATA)
      }
      const roles = agent === 'VENDOR' ? Types.TRoles.vendors : Types.TRoles.clients
      const include: Includeable[] = !identity
        ? [
            {
              model: DBModels.PNModel,
              where: {
                deviceId,
                role: {
                  [Domain.SqlDB.Op.in]: roles
                }
              },
              required: false
            }
          ]
        : [
            {
              model: DBModels.UserModel,
              where: { id: identity.id },
              required: false,
              include: [
                {
                  model: DBModels.PNModel,
                  required: false
                }
              ]
            }
          ]
      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity?.ikomidaID ?? iKomidaId
        },
        include
      })

      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_CONTRACT)
      }

      const userModel = contractModel?.users?.[0]
      let pNModel = userModel?.pN

      transaction = await Domain.SqlDB.sequelize.transaction({
        autocommit: false
      })
      if (pNModel) {
        pNModel.platform = payload?.platform
        pNModel.token = payload?.token
        pNModel.deviceId = deviceId
        await pNModel.save({ transaction })
      } else {
        await DBModels.PNModel.destroy({
          where: {
            deviceId,
            role: {
              [Domain.SqlDB.Op.in]: roles.flatMap(role => {
                return role.id
              })
            },
            contractId: contractModel.id
          },
          transaction
        })
        if (userModel) {
          pNModel = await userModel?.$create(
            'pN',
            {
              platform: payload.platform,
              token: payload.token,
              role: identity?.role,
              deviceId,
              contractId: contractModel.id
            },
            { transaction }
          )
        } else {
          pNModel = await contractModel?.$create(
            'pN',
            {
              platform: payload.platform,
              token: payload.token,
              role: identity?.role,
              deviceId
            },
            { transaction }
          )
        }
      }
      await transaction.commit()
      transaction = undefined
      return new Classes.Return(pNModel !== null)
    } catch (exception: any) {
      if (transaction) {
        await transaction?.rollback()
      }
      let error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_EXCEPTION, exception)
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  async newPushNotification(identity: Classes.CUser, input: any) {
    try {
      const payload: Classes.CNotification = Classes.CNotification.fromObject(input)
      if (!payload.validate() || !this.validatePushNotificationObject(payload)) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTIFICATION_MISSING_DATA)
      }

      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity.ikomidaID
        },
        include: [
          {
            model: DBModels.PlanModel,
            required: true
          },
          {
            model: DBModels.UserModel,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [Types.TRoles.VENDOR, Types.TRoles.STAFF, Types.TRoles.ADMIN]
              }
            },
            required: true
          },
          {
            model: DBModels.ContractPaymentSignatureModel,
            required: false
          }
        ]
      })

      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_MESSAGES_CONTRACT)
      }

      const countVendorPNMessages = await contractModel?.$count('vendorPNMessages', {
        where: {
          createdAt: {
            [Domain.SqlDB.Op.gt]: contractModel.contractPaymentSignature?.lastDueDate
          }
        }
      })
      const pNsLimit = contractModel?.plan?.pushNotifications ?? -1
      if (pNsLimit !== -1 && countVendorPNMessages >= pNsLimit) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTOFOCATION_LIMIT_EXCEEDED,
          pNsLimit
        )
      }

      const vendorPNMessage = await contractModel?.$create('vendorPNMessage', {
        title: payload?.title,
        body: payload?.body
      })
      if (!vendorPNMessage) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTOFOCATION_EXCEPTION,
          ''
        )
      }
      try {
        const payload = new Classes.CAMQPPayload<string>({
          method: 'sendVendorPushNotifications',
          object: vendorPNMessage?.id
        })
        const amqp = new Domain.RabbitMQ(this.logger)
        await amqp?.publish(Domain.RabbitMQ.VENDOR_PUSH_NOTIFICATION_QUEUE, payload)
        await amqp?.close()
      } catch (exception: any) {
        await vendorPNMessage.destroy()
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTOFOCATION_PUSH_NOTIFICATION_EXCEPTION,
          exception
        )
      }
      return new Classes.Return(true)
    } catch (exception: any) {
      let error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTOFOCATION_EXCEPTION,
        exception
      )
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  async getPushNotifications(identity: Classes.CUser, timestamp = 0) {
    try {
      const where =
        timestamp && timestamp != 0 && Number(Finances.toNumber(timestamp)) == timestamp
          ? {
              createdAt: {
                [Domain.SqlDB.Op.lt]: new Date(Number(Finances.toNumber(timestamp)))
              }
            }
          : {}
      const contractModel = await DBModels.ContractModel.findOne({
        subQuery: false,
        where: {
          ikomidaID: identity.ikomidaID
        },
        include: [
          {
            model: DBModels.PlanModel,
            required: true
          },
          {
            model: DBModels.UserModel,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [Types.TRoles.VENDOR, Types.TRoles.STAFF, Types.TRoles.ADMIN]
              }
            },
            required: true
          },
          {
            model: DBModels.VendorPNMessageModel,
            required: false,
            where,
            limit: this.limit
          }
        ]
      })
      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_MESSAGES_CONTRACT)
      }
      const pNMessages: Classes.CPushNotificationMessage[] = []
      //TODO: create class
      for (const vendorPNMessage of contractModel?.vendorPNMessages ?? []) {
        pNMessages?.push(
          Classes.CPushNotificationMessage.init(
            vendorPNMessage?.title,
            vendorPNMessage?.body,
            vendorPNMessage?.sends,
            vendorPNMessage?.fails,
            vendorPNMessage?.opens,
            vendorPNMessage?.createdAt,
            vendorPNMessage?.createdAt.getTime()
          )
        )
      }
      return new Classes.Return(true, pNMessages)
    } catch (exception: any) {
      let error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_PUSH_NOTOFOCATION_EXCEPTION,
        exception
      )
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  async getPushNotificationMessages(identity: Classes.CUser, timestamp = 0) {
    try {
      const where =
        timestamp && timestamp != 0 && Number(Finances.toNumber(timestamp)) == timestamp
          ? {
              createdAt: {
                [Domain.SqlDB.Op.lt]: new Date(Number(Finances.toNumber(timestamp)))
              }
            }
          : {}
      const contractModel = await DBModels.ContractModel.findOne({
        subQuery: false,
        where: {
          ikomidaID: identity.ikomidaID
        },
        include: [
          {
            model: DBModels.PlanModel,
            required: true
          },
          {
            model: DBModels.UserModel,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [Types.TRoles.CLIENT]
              }
            },
            required: true,
            include: [
              {
                model: DBModels.PNMessageModel,
                required: false,
                where,
                limit: this.limit
              }
            ]
          }
        ]
      })
      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_MESSAGES_CONTRACT)
      }
      const pNMessages: Classes.CPushNotificationMessage[] = []
      //TODO: create class
      for (const pNMessage of contractModel?.users?.[0].pNMessages ?? []) {
        pNMessages?.push(
          Classes.CPushNotificationMessage.init(
            pNMessage?.title,
            pNMessage?.body,
            undefined,
            undefined,
            undefined,
            pNMessage?.createdAt,
            pNMessage?.createdAt.getTime()
          )
        )
      }
      return new Classes.Return(true, pNMessages)
    } catch (exception: any) {
      let error = new Utils.iKomidaError(
        Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_PUSH_NOTOFOCATION_EXCEPTION,
        exception
      )
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  validateObject(object: any) {
    return objHasProp(['platform', 'token'], object)
  }
  validatePushNotificationObject(object: any) {
    return objHasProp(['title', 'body'], object)
  }
}
