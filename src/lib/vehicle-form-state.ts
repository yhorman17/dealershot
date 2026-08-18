export type VehicleFormValues = {
  vin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  series: string;
  body_class: string;
  engine: string;
  cylinders: string;
  transmission: string;
  drivetrain: string;
  fuel_type: string;
  exterior_color: string;
  interior_color: string;
  odometer: string;
  price: string;
  msrp: string;
  sale_price: string;
  price_description: string;
  stock_number: string;
  inventory_type: "new" | "used" | "certified";
  inventory_arrival_date: string;
  category: string;
  warranty_type: string;
  comments: string;
  custom_comments: string;
  tagline: string;
  publication_description: string;
  internal_notes: string;
  condition: string;
  status: string;
};

export const emptyVehicleValues: VehicleFormValues = {
  vin: "",
  year: "",
  make: "",
  model: "",
  trim: "",
  series: "",
  body_class: "",
  engine: "",
  cylinders: "",
  transmission: "",
  drivetrain: "",
  fuel_type: "",
  exterior_color: "",
  interior_color: "",
  odometer: "",
  price: "",
  msrp: "",
  sale_price: "",
  price_description: "",
  stock_number: "",
  inventory_type: "used",
  inventory_arrival_date: new Date().toISOString().slice(0, 10),
  category: "",
  warranty_type: "",
  comments: "",
  custom_comments: "",
  tagline: "",
  publication_description: "",
  internal_notes: "",
  condition: "Used",
  status: "Available",
};

export function normalizeVinInput(value: string) {
  return value.replace(/\s/g, "").toUpperCase();
}

export function deriveStockNumber(value: string) {
  return normalizeVinInput(value).slice(-8);
}

export type VehicleFormState = {
  values: VehicleFormValues;
  stockSource: "automatic" | "manual";
};

export type VehicleFormAction =
  | { type: "vin"; value: string }
  | { type: "stock"; value: string }
  | {
      type: "field";
      field: keyof VehicleFormValues;
      value: VehicleFormValues[keyof VehicleFormValues];
    }
  | { type: "patch"; values: Partial<VehicleFormValues> };

export function createVehicleFormState(initial?: VehicleFormValues): VehicleFormState {
  const supplied = initial ?? emptyVehicleValues;
  const vin = normalizeVinInput(supplied.vin);
  const hasProvidedStock = supplied.stock_number.trim().length > 0;
  return {
    values: {
      ...supplied,
      vin,
      stock_number: hasProvidedStock ? supplied.stock_number : deriveStockNumber(vin),
    },
    stockSource: hasProvidedStock ? "manual" : "automatic",
  };
}

export function vehicleFormReducer(
  state: VehicleFormState,
  action: VehicleFormAction,
): VehicleFormState {
  if (action.type === "vin") {
    const vin = normalizeVinInput(action.value);
    return {
      ...state,
      values: {
        ...state.values,
        vin,
        stock_number:
          state.stockSource === "automatic" ? deriveStockNumber(vin) : state.values.stock_number,
      },
    };
  }

  if (action.type === "stock") {
    if (action.value.length === 0) {
      return {
        stockSource: "automatic",
        values: { ...state.values, stock_number: deriveStockNumber(state.values.vin) },
      };
    }
    return {
      stockSource: "manual",
      values: { ...state.values, stock_number: action.value },
    };
  }

  if (action.type === "patch") {
    return { ...state, values: { ...state.values, ...action.values } };
  }

  return {
    ...state,
    values: { ...state.values, [action.field]: action.value },
  };
}
