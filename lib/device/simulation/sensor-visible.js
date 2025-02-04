/* jshint node: true,esversion: 9, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

module.exports = class deviceSensorVisible {
  constructor (platform, accessory, devicesInHB) {
    // Set up variables from the platform
    this.devicesInHB = devicesInHB
    this.disableDeviceLogging = platform.config.disableDeviceLogging
    this.eveChar = platform.eveChar
    this.funcs = platform.funcs
    this.hapChar = platform.api.hap.Characteristic
    this.hapServ = platform.api.hap.Service
    this.hapUUIDGen = platform.api.hap.uuid.generate
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.name = accessory.displayName
    this.accessory = accessory

    // Set up custom variables for this device type
    this.isDW2 = platform.consts.devices.sensorContact.includes(accessory.context.eweUIID)
    const deviceConf = platform.deviceConf[accessory.context.eweDeviceId]
    this.scaleBattery = deviceConf && deviceConf.scaleBattery
    this.lowBattThreshold =
      deviceConf && deviceConf.lowBattThreshold
        ? Math.min(deviceConf.lowBattThreshold, 100)
        : platform.consts.defaultValues.lowBattThreshold

    // Set the correct logging variables for this accessory
    this.enableLogging = !platform.config.disableDeviceLogging
    this.enableDebugLogging = platform.config.debug
    if (deviceConf && deviceConf.overrideLogging) {
      switch (deviceConf.overrideLogging) {
        case 'standard':
          this.enableLogging = true
          this.enableDebugLogging = false
          break
        case 'debug':
          this.enableLogging = true
          this.enableDebugLogging = true
          break
        case 'disable':
          this.enableLogging = false
          this.enableDebugLogging = false
          break
      }
    }

    // If the accessory has a leak sensor service then remove it
    if (this.accessory.getService(this.hapServ.LeakSensor)) {
      this.accessory.removeService(this.accessory.getService(this.hapServ.LeakSensor))
    }

    // Add the contact sensor service if it doesn't already exist
    if (!(this.service = this.accessory.getService(this.hapServ.ContactSensor))) {
      this.service = this.accessory.addService(this.hapServ.ContactSensor)
      this.service.addCharacteristic(this.eveChar.LastActivation)
      this.service.addCharacteristic(this.eveChar.ResetTotal)
      this.service.addCharacteristic(this.eveChar.OpenDuration)
      this.service.addCharacteristic(this.eveChar.ClosedDuration)
      this.service.addCharacteristic(this.eveChar.TimesOpened)
    }

    // Add the set handler to the contact sensor reset total characteristic
    this.service.getCharacteristic(this.eveChar.ResetTotal).onSet(value => {
      this.service.updateCharacteristic(this.eveChar.TimesOpened, 0)
    })

    // Add the battery service if it doesn't already exist
    this.batteryService =
      this.accessory.getService(this.hapServ.Battery) ||
      this.accessory.addService(this.hapServ.Battery)

    // Pass the accessory to Fakegato to set up with Eve
    this.accessory.eveService = new platform.eveService('door', this.accessory, {
      log: platform.config.debugFakegato ? this.log : () => {}
    })

    // Output the customised options to the log
    const opts = JSON.stringify({
      logging: this.enableDebugLogging ? 'debug' : this.enableLogging ? 'standard' : 'disable',
      lowBattThreshold: this.lowBattThreshold,
      scaleBattery: this.scaleBattery
    })
    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, opts)
  }

  async externalUpdate (params) {
    try {
      if (this.funcs.hasProperty(params, 'battery') && params.battery !== this.cacheBatt) {
        this.cacheBatt = params.battery
        if (this.isDW2) {
          this.cacheBattScaled = Math.min(Math.max(this.cacheBatt, 2), 3)
          this.cacheBattScaled = Math.round((this.cacheBattScaled - 2) * 100)
        } else {
          this.cacheBattScaled = this.scaleBattery ? this.cacheBatt * 10 : this.cacheBatt
        }
        this.cacheBattScaled = Math.max(Math.min(this.cacheBattScaled, 100), 0)
        this.batteryService.updateCharacteristic(this.hapChar.BatteryLevel, this.cacheBattScaled)
        this.batteryService.updateCharacteristic(
          this.hapChar.StatusLowBattery,
          this.cacheBattScaled < this.lowBattThreshold ? 1 : 0
        )
        if (params.updateSource && this.enableLogging) {
          this.log('[%s] %s [%s%].', this.name, this.lang.curBatt, this.cacheBattScaled)
        }
      }
      if (!this.funcs.hasProperty(params, 'lock') && !params.switch) {
        return
      }
      let newState
      if (params.switch) {
        newState = params.switch === 'on' ? 1 : 0
      } else {
        newState = params.lock
      }
      if (newState === this.cacheState) {
        return
      }
      this.cacheState = newState
      if (newState === 1) {
        this.service.updateCharacteristic(this.hapChar.ContactSensorState, 1)
        this.accessory.eveService.addEntry({ status: 1 })
        const initialTime = this.accessory.eveService.getInitialTime()
        this.service.updateCharacteristic(
          this.eveChar.LastActivation,
          Math.round(new Date().valueOf() / 1000) - initialTime
        )
        const newTO = this.service.getCharacteristic(this.eveChar.TimesOpened).value + 1
        this.service.updateCharacteristic(this.eveChar.TimesOpened, newTO)
      } else {
        this.service.updateCharacteristic(this.hapChar.ContactSensorState, 0)
        this.accessory.eveService.addEntry({ status: 0 })
      }
      if (params.updateSource && this.enableLogging) {
        this.log(
          '[%s] %s [%s].',
          this.name,
          this.lang.curState,
          newState === 0 ? this.lang.contactYes : this.lang.contactNo
        )
      }
      for (const [deviceId, group] of Object.entries(this.platform.deviceConf)) {
        if (
          group.sensorId === this.accessory.context.eweDeviceId &&
          group.showAs &&
          ['garage', 'lock'].includes(group.showAs)
        ) {
          const uuid = this.hapUUIDGen(deviceId + 'SWX')
          if (this.devicesInHB.has(uuid)) {
            const subAccessory = this.devicesInHB.get(uuid)

            // Set the correct logging variables for this accessory
            let enableLogging = !this.disableDeviceLogging
            if (group.overrideLogging) {
              switch (group.overrideLogging) {
                case 'standard':
                case 'debug':
                  enableLogging = true
                  break
                case 'disable':
                  enableLogging = false
                  break
              }
            }
            const isGarage = group.showAs === 'garage'
            const subService = subAccessory.getService(
              isGarage ? this.hapServ.GarageDoorOpener : this.hapServ.LockMechanism
            )
            const name = subAccessory.displayName
            switch (newState) {
              case 0:
                if (isGarage) {
                  subService.updateCharacteristic(this.hapChar.TargetDoorState, 1)
                  subService.updateCharacteristic(this.hapChar.CurrentDoorState, 1)
                  subAccessory.eveService.addEntry({ status: 1 })
                  if (params.updateSource && enableLogging) {
                    this.log('[%s] %s [%s].', name, this.lang.curState, this.lang.doorClosed)
                  }
                } else {
                  subService.updateCharacteristic(this.hapChar.LockTargetState, 1)
                  subService.updateCharacteristic(this.hapChar.LockCurrentState, 1)
                  subAccessory.context.contactDetected = true
                  if (params.updateSource && enableLogging) {
                    this.log('[%s] %s [%s].', name, this.lang.curState, this.lang.lockLocked)
                  }
                }
                break
              case 1: {
                if (isGarage) {
                  await this.funcs.sleep(Math.max(group.operationTime * 100, 2000))
                  subService.updateCharacteristic(this.hapChar.TargetDoorState, 0)
                  subService.updateCharacteristic(this.hapChar.CurrentDoorState, 0)
                  subAccessory.eveService.addEntry({ status: 0 })
                  const initialTime = subAccessory.eveService.getInitialTime()
                  subService.updateCharacteristic(
                    this.eveChar.LastActivation,
                    Math.round(new Date().valueOf() / 1000) - initialTime
                  )
                  subService.updateCharacteristic(
                    this.eveChar.TimesOpened,
                    subService.getCharacteristic(this.eveChar.TimesOpened).value + 1
                  )
                  if (params.updateSource && enableLogging) {
                    this.log('[%s] %s [%s].', name, this.lang.curState, this.lang.doorOpen)
                  }
                } else {
                  subService.updateCharacteristic(this.hapChar.LockTargetState, 0)
                  subService.updateCharacteristic(this.hapChar.LockCurrentState, 0)
                  subAccessory.context.contactDetected = false
                  if (params.updateSource && enableLogging) {
                    this.log('[%s] %s [%s].', name, this.lang.curState, this.lang.lockUnlocked)
                  }
                }
                break
              }
            }
          }
        }
      }
    } catch (err) {
      this.platform.deviceUpdateError(this.accessory, err, false)
    }
  }
}
