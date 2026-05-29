export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      backdrops: {
        Row: {
          created_at: string
          dealership_id: string
          id: string
          image_url: string
          name: string
        }
        Insert: {
          created_at?: string
          dealership_id: string
          id?: string
          image_url: string
          name: string
        }
        Update: {
          created_at?: string
          dealership_id?: string
          id?: string
          image_url?: string
          name?: string
        }
        Relationships: []
      }
      dealerships: {
        Row: {
          address: string | null
          created_at: string
          id: string
          logo_url: string | null
          name: string
          phone: string | null
          status: string
          subscription_status: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          name: string
          phone?: string | null
          status?: string
          subscription_status?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          logo_url?: string | null
          name?: string
          phone?: string | null
          status?: string
          subscription_status?: string
        }
        Relationships: []
      }
      documents: {
        Row: {
          created_at: string
          dealership_id: string
          id: string
          image_url: string
          name: string
        }
        Insert: {
          created_at?: string
          dealership_id: string
          id?: string
          image_url: string
          name: string
        }
        Update: {
          created_at?: string
          dealership_id?: string
          id?: string
          image_url?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      impersonation_logs: {
        Row: {
          created_at: string
          dealership_id: string
          ended_at: string | null
          id: string
          owner_id: string
          started_at: string
        }
        Insert: {
          created_at?: string
          dealership_id: string
          ended_at?: string | null
          id?: string
          owner_id: string
          started_at?: string
        }
        Update: {
          created_at?: string
          dealership_id?: string
          ended_at?: string | null
          id?: string
          owner_id?: string
          started_at?: string
        }
        Relationships: []
      }
      overlay_templates: {
        Row: {
          category: string | null
          created_at: string
          dealership_id: string | null
          id: string
          image_url: string
          name: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          dealership_id?: string | null
          id?: string
          image_url: string
          name: string
        }
        Update: {
          category?: string | null
          created_at?: string
          dealership_id?: string | null
          id?: string
          image_url?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "overlay_templates_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          created_at: string
          id: string
          image_url: string
          is_main: boolean
          overlay_id: string | null
          shot_type: string | null
          sort_order: number
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_url: string
          is_main?: boolean
          overlay_id?: string | null
          shot_type?: string | null
          sort_order?: number
          vehicle_id: string
        }
        Update: {
          created_at?: string
          id?: string
          image_url?: string
          is_main?: boolean
          overlay_id?: string | null
          shot_type?: string | null
          sort_order?: number
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "photos_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          dealership_id: string | null
          email: string
          full_name: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
        }
        Insert: {
          created_at?: string
          dealership_id?: string | null
          email: string
          full_name?: string | null
          id: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
        }
        Update: {
          created_at?: string
          dealership_id?: string | null
          email?: string
          full_name?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      user_invitations: {
        Row: {
          accepted_at: string | null
          dealership_id: string | null
          email: string
          expires_at: string
          full_name: string
          id: string
          invited_at: string
          invited_by: string
          role: string
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          dealership_id?: string | null
          email: string
          expires_at?: string
          full_name: string
          id?: string
          invited_at?: string
          invited_by: string
          role: string
          status?: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          dealership_id?: string | null
          email?: string
          expires_at?: string
          full_name?: string
          id?: string
          invited_at?: string
          invited_by?: string
          role?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_invitations_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_documents: {
        Row: {
          created_at: string
          document_id: string
          id: string
          is_main: boolean
          sort_order: number
          vehicle_id: string
        }
        Insert: {
          created_at?: string
          document_id: string
          id?: string
          is_main?: boolean
          sort_order?: number
          vehicle_id: string
        }
        Update: {
          created_at?: string
          document_id?: string
          id?: string
          is_main?: boolean
          sort_order?: number
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_documents_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_documents_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          body_class: string | null
          condition: string | null
          created_at: string
          cylinders: number | null
          dealership_id: string
          drivetrain: string | null
          engine: string | null
          exterior_color: string | null
          fuel_type: string | null
          id: string
          interior_color: string | null
          make: string | null
          model: string | null
          odometer: number | null
          price: number | null
          status: string | null
          stock_number: string | null
          transmission: string | null
          trim: string | null
          vin: string | null
          year: number | null
        }
        Insert: {
          body_class?: string | null
          condition?: string | null
          created_at?: string
          cylinders?: number | null
          dealership_id: string
          drivetrain?: string | null
          engine?: string | null
          exterior_color?: string | null
          fuel_type?: string | null
          id?: string
          interior_color?: string | null
          make?: string | null
          model?: string | null
          odometer?: number | null
          price?: number | null
          status?: string | null
          stock_number?: string | null
          transmission?: string | null
          trim?: string | null
          vin?: string | null
          year?: number | null
        }
        Update: {
          body_class?: string | null
          condition?: string | null
          created_at?: string
          cylinders?: number | null
          dealership_id?: string
          drivetrain?: string | null
          engine?: string | null
          exterior_color?: string | null
          fuel_type?: string | null
          id?: string
          interior_color?: string | null
          make?: string | null
          model?: string | null
          odometer?: number | null
          price?: number | null
          status?: string | null
          stock_number?: string | null
          transmission?: string | null
          trim?: string | null
          vin?: string | null
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: { Args: { _token: string }; Returns: Json }
      check_invitation_account_exists: {
        Args: { _token: string }
        Returns: boolean
      }
      get_invitation_details: {
        Args: { _token: string }
        Returns: {
          dealership_id: string
          dealership_name: string
          email: string
          expires_at: string
          full_name: string
          id: string
          role: string
          status: string
        }[]
      }
      get_user_dealership: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "owner" | "dealer_admin" | "staff"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "dealer_admin", "staff"],
    },
  },
} as const
