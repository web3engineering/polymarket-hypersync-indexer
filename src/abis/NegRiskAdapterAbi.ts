export const NegRiskAdapterAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "stakeholder", type: "address" },
      { indexed: true, internalType: "bytes32", name: "marketId", type: "bytes32" },
      { indexed: true, internalType: "uint256", name: "indexSet", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "PositionsConverted",
    type: "event",
  },
] as const;
