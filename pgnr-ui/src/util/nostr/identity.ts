import * as NIP01 from './nip01'
import * as secp256k1 from '@noble/secp256k1'
import { Buffer } from 'buffer'

export const generatePrivateKey = (): NIP01.Hex => {
  return Buffer.from(secp256k1.utils.randomPrivateKey()).toString('hex')
}

export const publicKey = (privateKey: string): NIP01.Hex => {
  return Buffer.from(secp256k1.schnorr.getPublicKey(privateKey)).toString('hex')
}
