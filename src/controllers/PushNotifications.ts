import { Domain, Utils, BackendTypes, Logics, Types, DBModels, objHasProp } from '@ikomida/shared-backend'

export default class PushNotifications {
  logger
  constructor(logger: Utils.Logger) {
    this.logger = logger
  }

  async register(identity: Types.Classes.CUser, input: any) {
    const payload: Types.Classes.CRegisterPushNotification = Types.Classes.CRegisterPushNotification.fromObject(input)
    if (!payload.validate() || !this.validateObject(payload)) {
      throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_MISSING_DATA)
    }
    try {
      const contractModel = await DBModels.ContractModel.findOne({
        where: {
          ikomidaID: identity.ikomidaID
        },
        include: [
          {
            model: DBModels.UserModel,
            where: {
              id: identity.id,
              role: {
                [Domain.SqlDB.Op.in]: [
                  BackendTypes.Roles.VENDOR,
                  BackendTypes.Roles.STAFF,
                  BackendTypes.Roles.CLIENT,
                  BackendTypes.Roles.ADMIN,
                  BackendTypes.Roles.RESELLER
                ]
              }
            },
            required: false,
            include: [
              {
                model: DBModels.PNModel,
                required: false
              }
            ]
          }
        ]
      })

      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_CONTRACT)
      }

      if ((contractModel?.users?.length ?? 0) !== 1) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_INVALID_USER)
      }

      const userModel = contractModel?.users?.[0]
      let pNModel = userModel?.pN
      if (pNModel) {
        pNModel.platform = payload?.platform
        pNModel.token = payload?.token
        await pNModel.save()
      } else {
        pNModel = await userModel?.$create('pN', {
          platform: payload.platform,
          token: payload.token,
          role: identity.role,
          contractId: contractModel.id
        })
      }
      return new Utils.Return(payload?.platform !== null && payload?.token !== null && pNModel !== null, {})
    } catch (exception: any) {
      let error = new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_REGISTER_EXCEPTION, exception)
      if (exception instanceof Utils.iKomidaError) {
        error = exception
      }
      return error.logAndReturn(this.logger)
    }
  }

  async newPushNotification(identity: Types.Classes.CUser, input: any) {
    let transaction: Domain.SqlDB.Transaction | undefined = undefined
    try {
      const payload: Types.Classes.CNotification = Types.Classes.CNotification.fromObject(input)
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.VENDOR, BackendTypes.Roles.STAFF, BackendTypes.Roles.ADMIN]
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
            [Domain.SqlDB.Op.gt]: Domain.SqlDB.Column('contractPaymentSignature.lastDueDate')
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

      transaction = await Domain.SqlDB.sequelize.transaction({
        autocommit: false
      })
      const vendorPNMessage = await contractModel?.$create(
        'vendorPNMessage',
        {
          title: payload?.title,
          body: payload?.body
        },
        { transaction }
      )
      try {
        const payload = new Types.Classes.CAMQPPayload<string>({
          method: 'sendVendorPushNotifications',
          object: vendorPNMessage?.id
        })
        const amqp = new Domain.RabbitMQ(this.logger)
        await amqp?.publish(Domain.RabbitMQ.VENDOR_PUSH_NOTIFICATION_QUEUE, payload)
        await amqp?.close()
      } catch (exception: any) {
        throw new Utils.iKomidaError(
          Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_NEW_PUSH_NOTOFOCATION_PUSH_NOTIFICATION_EXCEPTION,
          exception
        )
      }
      await transaction.commit()
      return new Utils.Return(true)
    } catch (exception: any) {
      await transaction?.rollback()
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

  async getPushNotifications(identity: Types.Classes.CUser, timestamp = 0) {
    try {
      const where =
        timestamp && timestamp != 0 && Number(Logics.Finances.toNumber(timestamp)) == timestamp
          ? {
              createdAt: {
                [Domain.SqlDB.Op.lt]: new Date(Number(Logics.Finances.toNumber(timestamp)))
              }
            }
          : {}
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
                [Domain.SqlDB.Op.in]: [BackendTypes.Roles.VENDOR, BackendTypes.Roles.STAFF, BackendTypes.Roles.ADMIN]
              }
            },
            required: true
          },
          {
            model: DBModels.VendorPNMessageModel,
            required: false,
            where
          }
        ]
      })
      if (!contractModel) {
        throw new Utils.iKomidaError(Utils.iKomidaError.IKOMIDA_NOTIFICATION_SERVICE_GET_MESSAGES_CONTRACT)
      }
      const pNMessages = []
      //TODO: create class
      for (const vendorPNMessage of contractModel?.vendorPNMessages ?? []) {
        pNMessages?.push({
          title: vendorPNMessage?.title,
          body: vendorPNMessage?.body,
          sends: vendorPNMessage?.sends,
          fails: vendorPNMessage?.fails,
          opens: vendorPNMessage?.opens,
          createdAt: vendorPNMessage?.createdAt
        })
      }
      return new Utils.Return(true, pNMessages)
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
