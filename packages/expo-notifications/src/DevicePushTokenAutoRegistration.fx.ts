import { CodedError, Platform } from '@unimodules/core';
import * as Application from 'expo-application';

import ServerRegistrationModule from './ServerRegistrationModule';
import { addPushTokenListener } from './TokenEmitter';
import { DevicePushToken } from './Tokens.types';

/**
 * Encapsulates device server registration data
 */
export type Registration = {
  url: string;
  body: Record<string, any>;
};

/**
 * Sets the last registration information so that the device push token
 * gets pushed to the given registration endpoint
 * @param registration Registration endpoint to inform of new tokens
 */
export async function setAutoServerRegistrationAsync(registration: Registration) {
  await ServerRegistrationModule.setLastRegistrationInfoAsync?.(JSON.stringify(registration));
}

/**
 * Removes last Expo server registration, future device push token
 * updates won't get sent there anymore.
 */
export async function removeAutoServerRegistrationAsync() {
  await ServerRegistrationModule.setLastRegistrationInfoAsync?.(null);
}

// A global scope (to get all the updates) device push token
// subscription, never cleared.
addPushTokenListener(token => {
  retry(() => updatePushTokenAsync(token), 500, 1000 * 60 * 2);
});

let nextTryTimeoutId: number | undefined = undefined;
function retry(fn: () => Promise<unknown>, delay: number, maxDelay: number) {
  if (nextTryTimeoutId) {
    clearTimeout(nextTryTimeoutId);
  }
  fn().catch(error => {
    console.warn(
      '[expo-notifications] Error encountered while updating device push token in server:',
      error
    );

    // We only want to retry if it was a network error.
    // Other error may be JSON.parse error which we can do nothing about.
    if (
      error instanceof CodedError &&
      (error as CodedError).code === 'ERR_NOTIFICATIONS_NETWORK_ERROR'
    ) {
      // @ts-ignore: TS can't decide whether to use Node types or RN types
      nextTryTimeoutId = setTimeout(
        () => retry(fn, Math.min(delay * 2, maxDelay), maxDelay),
        delay
      );
    }
  });
}

async function updatePushTokenAsync(token: DevicePushToken) {
  // Fetch the latest registration info from the persisted storage
  const lastRegistrationInfo = await ServerRegistrationModule.getLastRegistrationInfoAsync?.();
  // If there is none, do not to anything.
  if (!lastRegistrationInfo) {
    return;
  }

  // Prepare request body
  const lastRegistration: Registration = JSON.parse(lastRegistrationInfo);
  const body = {
    ...lastRegistration.body,
    // Information whether a token is applicable
    // to development or production notification service
    // should never be persisted as it can change between
    // Xcode development and TestFlight/AppStore without
    // backing store being resetted (development registration
    // remains in production environment).
    development: await shouldUseDevelopmentNotificationService(),
    deviceToken: token.data,
    type: getTypeOfToken(token),
  };

  // Do register
  await fetch(lastRegistration.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }).catch(error => {
    throw new CodedError(
      'ERR_NOTIFICATIONS_NETWORK_ERROR',
      `Error encountered while updating device push token in server: ${error}.`
    );
  });
}

// Same as in getExpoPushTokenAsync
function getTypeOfToken(devicePushToken: DevicePushToken) {
  switch (devicePushToken.type) {
    case 'ios':
      return 'apns';
    case 'android':
      return 'fcm';
    // This probably will error on server, but let's make this function future-safe.
    default:
      return devicePushToken.type;
  }
}

// Same as in getExpoPushTokenAsync
async function shouldUseDevelopmentNotificationService() {
  if (Platform.OS === 'ios') {
    try {
      const notificationServiceEnvironment = await Application.getIosPushNotificationServiceEnvironmentAsync();
      if (notificationServiceEnvironment === 'development') {
        return true;
      }
    } catch (e) {
      // We can't do anything here, we'll fallback to false then.
    }
  }

  return false;
}
