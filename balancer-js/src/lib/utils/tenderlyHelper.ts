import dotenv from 'dotenv';
import axios from 'axios';
import { MaxUint256 } from '@ethersproject/constants';
import { networkAddresses } from '@/lib/constants/config';

dotenv.config();
const { TENDERLY_USER, TENDERLY_PROJECT, TENDERLY_ACCESS_KEY } = process.env;

const opts = {
  headers: {
    'X-Access-Key': TENDERLY_ACCESS_KEY as string,
  },
};

type StateOverrides = {
  [address: string]: { value: { [key: string]: string } };
};

export const simulateTransaction = async (
  to: string,
  data: string,
  userAddress: string,
  tokensIn: string[],
  chainId: number
): Promise<string> => {
  const { contracts } = networkAddresses(chainId);
  const vaultAddress = contracts.vault as string;

  // Encode token balances and allowances overrides to max value before performing simulation
  const encodedStateOverrides = await encodeBalanceAndAllowanceOverrides(
    userAddress,
    tokensIn,
    chainId,
    vaultAddress
  );

  // Map encoded-state response into simulate request body by replacing property names
  let state_objects;
  if (encodedStateOverrides) {
    state_objects = Object.fromEntries(
      Object.keys(encodedStateOverrides).map((address) => {
        // Object.fromEntries require format [key, value] instead of {key: value}
        return [address, { storage: encodedStateOverrides[address].value }];
      })
    );
  }

  const body = {
    // -- Standard TX fields --
    network_id: chainId.toString(),
    from: userAddress,
    to,
    input: data,
    // gas: 8000000,
    // gas_price: '0',
    // value: '0',
    // -- Simulation config (tenderly specific) --
    save_if_fails: true,
    // save: true,
    state_objects,
  };

  const SIMULATE_URL = `https://api.tenderly.co/api/v1/account/${TENDERLY_USER}/project/${TENDERLY_PROJECT}/simulate`;

  const resp = await axios.post(SIMULATE_URL, body, opts);

  const simulatedTransactionOutput =
    resp.data.transaction.transaction_info.call_trace.output;

  return simulatedTransactionOutput;
};

const encodeBalanceAndAllowanceOverrides = async (
  userAddress: string,
  tokens: string[],
  chainId: number,
  vaultAddress: string
): Promise<StateOverrides | undefined> => {
  // Create balances and allowances overrides for each token address provided
  let stateOverrides: StateOverrides = {};
  tokens.forEach(
    (token) =>
      (stateOverrides = {
        ...stateOverrides,
        [`${token}`]: {
          value: {
            [`_balances[${userAddress}]`]: MaxUint256.toString(),
            [`_allowances[${userAddress}][${vaultAddress}]`]:
              MaxUint256.toString(),
            [`balanceOf[${userAddress}]`]: MaxUint256.toString(),
            [`allowance[${userAddress}][${vaultAddress}]`]:
              MaxUint256.toString(),
            [`balances[${userAddress}]`]: MaxUint256.toString(),
            [`allowed[${userAddress}][${vaultAddress}]`]: MaxUint256.toString(),
          },
        },
      })
  );

  const ENCODE_STATES_URL = `https://api.tenderly.co/api/v1/account/${TENDERLY_USER}/project/${TENDERLY_PROJECT}/contracts/encode-states`;
  const body = {
    networkID: chainId.toString(),
    stateOverrides,
  };

  const encodedStatesResponse = await axios.post(ENCODE_STATES_URL, body, opts);
  const encodedStateOverrides = encodedStatesResponse.data.stateOverrides as
    | StateOverrides
    | undefined;

  return encodedStateOverrides;
};
