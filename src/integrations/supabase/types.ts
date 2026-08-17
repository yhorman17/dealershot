export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type TableDefinition<Row> = {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      backdrops: {
        Row: {
          created_at: string;
          dealership_id: string;
          id: string;
          image_url: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          dealership_id: string;
          id?: string;
          image_url: string;
          name: string;
        };
        Update: {
          created_at?: string;
          dealership_id?: string;
          id?: string;
          image_url?: string;
          name?: string;
        };
        Relationships: [];
      };
      dealerships: {
        Row: {
          address: string | null;
          branding: Json;
          created_at: string;
          id: string;
          logo_url: string | null;
          name: string;
          organization_id: string;
          phone: string | null;
          status: string;
          subscription_status: string;
          timezone: string;
          updated_at: string;
          website: string | null;
        };
        Insert: {
          address?: string | null;
          branding?: Json;
          created_at?: string;
          id?: string;
          logo_url?: string | null;
          name: string;
          organization_id?: string;
          phone?: string | null;
          status?: string;
          subscription_status?: string;
          timezone?: string;
          updated_at?: string;
          website?: string | null;
        };
        Update: {
          address?: string | null;
          branding?: Json;
          created_at?: string;
          id?: string;
          logo_url?: string | null;
          name?: string;
          organization_id?: string;
          phone?: string | null;
          status?: string;
          subscription_status?: string;
          timezone?: string;
          updated_at?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      dealership_settings: {
        Row: {
          dealership_id: string;
          read_scope: string;
          setting_key: string;
          setting_value: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          dealership_id: string;
          read_scope?: string;
          setting_key: string;
          setting_value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          dealership_id?: string;
          read_scope?: string;
          setting_key?: string;
          setting_value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "dealership_settings_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
      documents: {
        Row: {
          created_at: string;
          dealership_id: string;
          id: string;
          image_url: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          dealership_id: string;
          id?: string;
          image_url: string;
          name: string;
        };
        Update: {
          created_at?: string;
          dealership_id?: string;
          id?: string;
          image_url?: string;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "documents_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
      impersonation_logs: {
        Row: {
          created_at: string;
          dealership_id: string;
          ended_at: string | null;
          id: string;
          owner_id: string;
          started_at: string;
        };
        Insert: {
          created_at?: string;
          dealership_id: string;
          ended_at?: string | null;
          id?: string;
          owner_id: string;
          started_at?: string;
        };
        Update: {
          created_at?: string;
          dealership_id?: string;
          ended_at?: string | null;
          id?: string;
          owner_id?: string;
          started_at?: string;
        };
        Relationships: [];
      };
      overlay_templates: {
        Row: {
          category: string | null;
          created_at: string;
          dealership_id: string | null;
          id: string;
          image_url: string;
          name: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string;
          dealership_id?: string | null;
          id?: string;
          image_url: string;
          name: string;
        };
        Update: {
          category?: string | null;
          created_at?: string;
          dealership_id?: string | null;
          id?: string;
          image_url?: string;
          name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "overlay_templates_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
      platform_settings: {
        Row: {
          setting_key: string;
          setting_value: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          setting_key: string;
          setting_value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          setting_key?: string;
          setting_value?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      photo_capture_sessions: {
        Row: {
          completion_policy: "block" | "warn";
          completed_at: string | null;
          completed_by: string | null;
          created_at: string;
          created_by: string | null;
          dealership_id: string;
          detail_count: number;
          duration_seconds: number | null;
          exterior_count: number;
          id: string;
          interior_count: number;
          mode: "guided" | "bulk";
          missing_requirements: Json;
          notes: string | null;
          photo_count: number;
          prepared_at: string | null;
          prepared_by: string | null;
          reshoot_of: string | null;
          review_status: "unreviewed" | "awaiting_review" | "approved" | "rejected";
          requirements_snapshot: Json;
          shoot_type: "standard" | "reshoot" | "bulk";
          started_at: string;
          status: "in_progress" | "completed" | "prepared";
          updated_at: string;
          vehicle_id: string | null;
          video_count: number;
          vin: string | null;
        };
        Insert: {
          completion_policy?: "block" | "warn";
          completed_at?: string | null;
          completed_by?: string | null;
          created_at?: string;
          created_by: string;
          dealership_id: string;
          detail_count?: number;
          duration_seconds?: number | null;
          exterior_count?: number;
          id?: string;
          interior_count?: number;
          mode: "guided" | "bulk";
          missing_requirements?: Json;
          notes?: string | null;
          photo_count?: number;
          prepared_at?: string | null;
          prepared_by?: string | null;
          reshoot_of?: string | null;
          review_status?: "unreviewed" | "awaiting_review" | "approved" | "rejected";
          requirements_snapshot?: Json;
          shoot_type?: "standard" | "reshoot" | "bulk";
          started_at?: string;
          status?: "in_progress" | "completed" | "prepared";
          updated_at?: string;
          vehicle_id?: string | null;
          video_count?: number;
          vin?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      photography_settings: TableDefinition<{
        dealership_id: string;
        completion_policy: "block" | "warn";
        updated_by: string | null;
        updated_at: string;
      }>;
      photo_shot_requirements: TableDefinition<{
        id: string;
        dealership_id: string;
        shot_key: string;
        label: string;
        guidance: string | null;
        category: "exterior" | "interior" | "detail" | "odometer" | "vin";
        required: boolean;
        enabled: boolean;
        minimum_count: number;
        applies_to: string[];
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>;
      bulk_photo_items: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          image_url: string;
          is_main: boolean;
          photo_id: string | null;
          session_id: string;
          shot_type: string | null;
          sort_order: number;
          storage_path: string;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          id?: string;
          image_url: string;
          is_main?: boolean;
          photo_id?: string | null;
          session_id: string;
          shot_type?: string | null;
          sort_order?: number;
          storage_path: string;
        };
        Update: {
          is_main?: boolean;
          shot_type?: string | null;
          sort_order?: number;
        };
        Relationships: [];
      };
      photos: {
        Row: {
          approved_variant_id: string | null;
          capture_session_id: string | null;
          created_at: string;
          corrected_cutout_url: string | null;
          cutout_image_url: string | null;
          cutout_status: string;
          id: string;
          image_url: string;
          is_cutout: boolean;
          is_main: boolean;
          media_category:
            | "exterior"
            | "interior"
            | "detail"
            | "odometer"
            | "vin"
            | "document"
            | "misc";
          media_kind: "photo" | "video" | "exterior_360" | "interior_360";
          metadata: Json;
          overlay_id: string | null;
          original_image_url: string;
          photo_state: "raw" | "cutout" | "customized";
          processing_action:
            | "keep_original"
            | "enhance"
            | "background_replace"
            | "background_merchandising"
            | "manual_review";
          processing_error: string | null;
          processing_provider: string | null;
          processing_status: "not_required" | "queued" | "processing" | "completed" | "failed";
          publication_status: "unpublished" | "pending" | "published" | "failed";
          quality_issues: Json;
          review_status: "unreviewed" | "awaiting_review" | "approved" | "rejected";
          shot_type: string | null;
          sort_order: number;
          updated_at: string;
          vehicle_id: string;
        };
        Insert: {
          approved_variant_id?: string | null;
          capture_session_id?: string | null;
          created_at?: string;
          corrected_cutout_url?: string | null;
          cutout_image_url?: string | null;
          cutout_status?: string;
          id?: string;
          image_url: string;
          is_cutout?: boolean;
          is_main?: boolean;
          media_category?:
            | "exterior"
            | "interior"
            | "detail"
            | "odometer"
            | "vin"
            | "document"
            | "misc";
          media_kind?: "photo" | "video" | "exterior_360" | "interior_360";
          metadata?: Json;
          overlay_id?: string | null;
          original_image_url?: string;
          photo_state?: "raw" | "cutout" | "customized";
          processing_action?:
            | "keep_original"
            | "enhance"
            | "background_replace"
            | "background_merchandising"
            | "manual_review";
          processing_error?: string | null;
          processing_provider?: string | null;
          processing_status?: "not_required" | "queued" | "processing" | "completed" | "failed";
          publication_status?: "unpublished" | "pending" | "published" | "failed";
          quality_issues?: Json;
          review_status?: "unreviewed" | "awaiting_review" | "approved" | "rejected";
          shot_type?: string | null;
          sort_order?: number;
          updated_at?: string;
          vehicle_id: string;
        };
        Update: {
          approved_variant_id?: string | null;
          capture_session_id?: string | null;
          created_at?: string;
          corrected_cutout_url?: string | null;
          cutout_image_url?: string | null;
          cutout_status?: string;
          id?: string;
          image_url?: string;
          is_cutout?: boolean;
          is_main?: boolean;
          media_category?:
            | "exterior"
            | "interior"
            | "detail"
            | "odometer"
            | "vin"
            | "document"
            | "misc";
          media_kind?: "photo" | "video" | "exterior_360" | "interior_360";
          metadata?: Json;
          overlay_id?: string | null;
          original_image_url?: string;
          photo_state?: "raw" | "cutout" | "customized";
          processing_action?:
            | "keep_original"
            | "enhance"
            | "background_replace"
            | "background_merchandising"
            | "manual_review";
          processing_error?: string | null;
          processing_provider?: string | null;
          processing_status?: "not_required" | "queued" | "processing" | "completed" | "failed";
          publication_status?: "unpublished" | "pending" | "published" | "failed";
          quality_issues?: Json;
          review_status?: "unreviewed" | "awaiting_review" | "approved" | "rejected";
          shot_type?: string | null;
          sort_order?: number;
          updated_at?: string;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "photos_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          dealership_id: string | null;
          email: string;
          full_name: string | null;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          status: string;
        };
        Insert: {
          created_at?: string;
          dealership_id?: string | null;
          email: string;
          full_name?: string | null;
          id: string;
          role?: Database["public"]["Enums"]["app_role"];
          status?: string;
        };
        Update: {
          created_at?: string;
          dealership_id?: string | null;
          email?: string;
          full_name?: string | null;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
      profile_dealerships: {
        Row: {
          access_role:
            | "dealer_admin"
            | "store_manager"
            | "photographer"
            | "inventory_media"
            | "accounting";
          created_at: string;
          dealership_id: string;
          payout_eligible: boolean;
          profile_id: string;
        };
        Insert: {
          access_role?:
            | "dealer_admin"
            | "store_manager"
            | "photographer"
            | "inventory_media"
            | "accounting";
          created_at?: string;
          dealership_id: string;
          payout_eligible?: boolean;
          profile_id: string;
        };
        Update: {
          access_role?:
            | "dealer_admin"
            | "store_manager"
            | "photographer"
            | "inventory_media"
            | "accounting";
          created_at?: string;
          dealership_id?: string;
          payout_eligible?: boolean;
          profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profile_dealerships_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profile_dealerships_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_events: {
        Row: {
          actor_profile_id: string | null;
          dealership_id: string | null;
          event_type: string;
          id: number;
          occurred_at: string;
          payload: Json;
          request_id: string | null;
          target_profile_id: string | null;
        };
        Insert: {
          actor_profile_id?: string | null;
          dealership_id?: string | null;
          event_type: string;
          id?: number;
          occurred_at?: string;
          payload?: Json;
          request_id?: string | null;
          target_profile_id?: string | null;
        };
        Update: {
          actor_profile_id?: string | null;
          dealership_id?: string | null;
          event_type?: string;
          id?: number;
          occurred_at?: string;
          payload?: Json;
          request_id?: string | null;
          target_profile_id?: string | null;
        };
        Relationships: [];
      };
      user_account_operation_dealerships: {
        Row: { dealership_id: string; operation_id: string; position: number };
        Insert: { dealership_id: string; operation_id: string; position: number };
        Update: { dealership_id?: string; operation_id?: string; position?: number };
        Relationships: [];
      };
      user_account_operations: {
        Row: {
          actor_profile_id: string;
          completed_at: string | null;
          created_at: string;
          id: string;
          idempotency_key: string;
          operation_type: string;
          primary_dealership_id: string | null;
          requested_full_name: string | null;
          requested_role: Database["public"]["Enums"]["app_role"] | null;
          safe_error_code: string | null;
          status: string;
          target_email: string;
          target_profile_id: string | null;
          updated_at: string;
        };
        Insert: {
          actor_profile_id: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key: string;
          operation_type: string;
          primary_dealership_id?: string | null;
          requested_full_name?: string | null;
          requested_role?: Database["public"]["Enums"]["app_role"] | null;
          safe_error_code?: string | null;
          status?: string;
          target_email: string;
          target_profile_id?: string | null;
          updated_at?: string;
        };
        Update: {
          actor_profile_id?: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          idempotency_key?: string;
          operation_type?: string;
          primary_dealership_id?: string | null;
          requested_full_name?: string | null;
          requested_role?: Database["public"]["Enums"]["app_role"] | null;
          safe_error_code?: string | null;
          status?: string;
          target_email?: string;
          target_profile_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_onboarding: {
        Row: {
          completed_at: string | null;
          credential_issued_at: string | null;
          issued_by: string | null;
          onboarding_method: string;
          onboarding_state: string;
          password_change_required: boolean;
          password_changed_at: string | null;
          profile_id: string;
          updated_at: string;
        };
        Insert: {
          completed_at?: string | null;
          credential_issued_at?: string | null;
          issued_by?: string | null;
          onboarding_method?: string;
          onboarding_state?: string;
          password_change_required?: boolean;
          password_changed_at?: string | null;
          profile_id: string;
          updated_at?: string;
        };
        Update: {
          completed_at?: string | null;
          credential_issued_at?: string | null;
          issued_by?: string | null;
          onboarding_method?: string;
          onboarding_state?: string;
          password_change_required?: boolean;
          password_changed_at?: string | null;
          profile_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_invitations: {
        Row: {
          accepted_at: string | null;
          dealership_id: string | null;
          email: string;
          expires_at: string;
          full_name: string;
          id: string;
          invited_at: string;
          invited_by: string;
          role: string;
          status: string;
          token: string;
        };
        Insert: {
          accepted_at?: string | null;
          dealership_id?: string | null;
          email: string;
          expires_at?: string;
          full_name: string;
          id?: string;
          invited_at?: string;
          invited_by: string;
          role: string;
          status?: string;
          token: string;
        };
        Update: {
          accepted_at?: string | null;
          dealership_id?: string | null;
          email?: string;
          expires_at?: string;
          full_name?: string;
          id?: string;
          invited_at?: string;
          invited_by?: string;
          role?: string;
          status?: string;
          token?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_invitations_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
      vehicle_documents: {
        Row: {
          created_at: string;
          document_id: string;
          id: string;
          is_main: boolean;
          sort_order: number;
          vehicle_id: string;
        };
        Insert: {
          created_at?: string;
          document_id: string;
          id?: string;
          is_main?: boolean;
          sort_order?: number;
          vehicle_id: string;
        };
        Update: {
          created_at?: string;
          document_id?: string;
          id?: string;
          is_main?: boolean;
          sort_order?: number;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_documents_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vehicle_documents_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: TableDefinition<{
        id: string;
        name: string;
        status: "active" | "suspended";
        created_at: string;
        updated_at: string;
      }>;
      organization_memberships: TableDefinition<{
        organization_id: string;
        profile_id: string;
        role: "group_admin" | "reporting";
        created_at: string;
      }>;
      vehicle_equipment: TableDefinition<{
        id: string;
        vehicle_id: string;
        category:
          | "safety"
          | "interior"
          | "exterior"
          | "mechanical"
          | "entertainment"
          | "convenience";
        feature_code: string | null;
        label: string;
        value: string | null;
        source: "manual" | "provider" | "import";
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>;
      vehicle_warranties: TableDefinition<{
        vehicle_id: string;
        basic_years: number | null;
        basic_miles: number | null;
        drivetrain_years: number | null;
        drivetrain_miles: number | null;
        corrosion_years: number | null;
        corrosion_miles: number | null;
        roadside_years: number | null;
        roadside_miles: number | null;
        notes: string | null;
        source: "manual" | "provider" | "import";
        updated_at: string;
      }>;
      media_processing_rules: TableDefinition<{
        id: string;
        dealership_id: string;
        media_category:
          | "exterior"
          | "interior"
          | "detail"
          | "odometer"
          | "vin"
          | "document"
          | "misc";
        action:
          | "keep_original"
          | "enhance"
          | "background_replace"
          | "background_merchandising"
          | "manual_review";
        template_id: string | null;
        enabled: boolean;
        priority: number;
        config: Json;
        created_at: string;
        updated_at: string;
      }>;
      media_variants: TableDefinition<{
        id: string;
        photo_id: string;
        variant_type:
          | "original"
          | "cutout"
          | "corrected_cutout"
          | "customized"
          | "enhanced"
          | "published";
        source_variant_id: string | null;
        image_url: string;
        storage_path: string | null;
        processing_provider: string | null;
        processing_status: "queued" | "processing" | "completed" | "failed";
        width: number | null;
        height: number | null;
        byte_size: number | null;
        checksum: string | null;
        metadata: Json;
        created_by: string | null;
        created_at: string;
      }>;
      readiness_rules: TableDefinition<{
        id: string;
        dealership_id: string;
        rule_key: string;
        label: string;
        severity: "attention" | "blocked";
        applies_to: string[];
        config: Json;
        enabled: boolean;
        sort_order: number;
        created_at: string;
        updated_at: string;
      }>;
      document_templates: TableDefinition<{
        id: string;
        organization_id: string | null;
        dealership_id: string | null;
        document_type: "window_sticker" | "buyers_guide" | "addendum" | "cpo_sheet" | "placard";
        name: string;
        version: number;
        status: "draft" | "active" | "retired";
        template_config: Json;
        created_by: string | null;
        created_at: string;
        updated_at: string;
      }>;
      document_requirements: TableDefinition<{
        dealership_id: string;
        document_type: "window_sticker" | "buyers_guide" | "addendum" | "cpo_sheet" | "placard";
        applies_to: string[];
        required: boolean;
        enabled: boolean;
        updated_by: string | null;
        updated_at: string;
      }>;
      generated_documents: TableDefinition<{
        id: string;
        vehicle_id: string;
        organization_id: string;
        dealership_id: string;
        document_type: "window_sticker" | "buyers_guide" | "addendum" | "cpo_sheet" | "placard";
        template_id: string | null;
        template_version: number;
        vehicle_snapshot: Json;
        file_url: string | null;
        storage_path: string | null;
        status: "generating" | "generated" | "failed" | "superseded";
        safe_error_code: string | null;
        generated_by: string | null;
        generated_at: string;
        source_updated_at: string;
        stale_at: string | null;
        stale_reason: string | null;
        updated_at: string;
      }>;
      vehicle_readiness: TableDefinition<{
        vehicle_id: string;
        dealership_id: string;
        status: "retail_ready" | "needs_attention" | "blocked" | "processing" | "awaiting_review";
        reasons: Json;
        photo_count: number;
        video_count: number;
        completed_document_count: number;
        evaluated_at: string;
        evaluator_version: number;
      }>;
      activity_events: TableDefinition<{
        id: number;
        organization_id: string;
        dealership_id: string;
        vehicle_id: string | null;
        photo_shoot_id: string | null;
        actor_profile_id: string | null;
        event_type: string;
        description: string;
        metadata: Json;
        occurred_at: string;
      }>;
      payout_rules: TableDefinition<{
        id: string;
        dealership_id: string;
        name: string;
        task_type:
          | "photo_shoot"
          | "video"
          | "exterior_360"
          | "interior_360"
          | "reshoot"
          | "audit"
          | "manual";
        amount: number;
        version: number;
        effective_from: string;
        effective_to: string | null;
        active: boolean;
        config: Json;
        created_by: string | null;
        created_at: string;
      }>;
      payout_entries: TableDefinition<{
        id: string;
        dealership_id: string;
        organization_id: string;
        employee_id: string;
        vehicle_id: string | null;
        photo_shoot_id: string | null;
        activity_event_id: number | null;
        task_type:
          | "photo_shoot"
          | "video"
          | "exterior_360"
          | "interior_360"
          | "reshoot"
          | "audit"
          | "manual";
        work_date: string;
        amount: number;
        currency: string;
        rule_id: string | null;
        rule_snapshot: Json;
        status: "pending" | "approved" | "paid" | "void";
        approved_by: string | null;
        approved_at: string | null;
        paid_by: string | null;
        paid_at: string | null;
        notes: string | null;
        created_at: string;
        updated_at: string;
      }>;
      integration_connections: TableDefinition<{
        id: string;
        organization_id: string;
        dealership_id: string | null;
        provider_type:
          | "inventory_import"
          | "vehicle_data"
          | "media_publishing"
          | "inventory_publishing";
        provider_key: string;
        display_name: string;
        status: "not_configured" | "disabled" | "ready" | "syncing" | "healthy" | "failed";
        external_dealership_id: string | null;
        configuration_metadata: Json;
        last_sync_at: string | null;
        last_success_at: string | null;
        last_failure_at: string | null;
        last_error_code: string | null;
        created_at: string;
        updated_at: string;
      }>;
      vehicle_publications: TableDefinition<{
        id: string;
        vehicle_id: string;
        integration_connection_id: string;
        status: "pending" | "publishing" | "published" | "failed" | "disabled";
        external_vehicle_id: string | null;
        last_attempt_at: string | null;
        last_success_at: string | null;
        last_error_code: string | null;
        updated_at: string;
      }>;
      vehicles: {
        Row: {
          assigned_photographer_id: string | null;
          body_class: string | null;
          category: string | null;
          certification_program: string | null;
          comments: string | null;
          condition: string | null;
          created_at: string;
          custom_comments: string | null;
          cylinders: number | null;
          dealership_id: string;
          drivetrain: string | null;
          engine: string | null;
          exterior_color: string | null;
          fuel_type: string | null;
          id: string;
          interior_color: string | null;
          internal_notes: string | null;
          internet_price: number | null;
          inventory_arrival_date: string | null;
          inventory_type: "new" | "used" | "certified" | null;
          make: string | null;
          model: string | null;
          odometer: number | null;
          price: number | null;
          price_description: string | null;
          publication_description: string | null;
          publication_state: "disabled" | "pending" | "publishing" | "published" | "failed";
          retail_readiness_status:
            | "retail_ready"
            | "needs_attention"
            | "blocked"
            | "processing"
            | "awaiting_review";
          sale_price: number | null;
          series: string | null;
          source_external_id: string | null;
          source_metadata: Json;
          source_provider: string | null;
          status: string | null;
          stock_number: string | null;
          tagline: string | null;
          transmission: string | null;
          trim: string | null;
          updated_at: string;
          vin: string | null;
          warranty_type: string | null;
          year: number | null;
          msrp: number | null;
        };
        Insert: {
          assigned_photographer_id?: string | null;
          body_class?: string | null;
          category?: string | null;
          certification_program?: string | null;
          comments?: string | null;
          condition?: string | null;
          created_at?: string;
          custom_comments?: string | null;
          cylinders?: number | null;
          dealership_id: string;
          drivetrain?: string | null;
          engine?: string | null;
          exterior_color?: string | null;
          fuel_type?: string | null;
          id?: string;
          interior_color?: string | null;
          internal_notes?: string | null;
          internet_price?: number | null;
          inventory_arrival_date?: string | null;
          inventory_type?: "new" | "used" | "certified" | null;
          make?: string | null;
          model?: string | null;
          odometer?: number | null;
          price?: number | null;
          price_description?: string | null;
          publication_description?: string | null;
          publication_state?: "disabled" | "pending" | "publishing" | "published" | "failed";
          retail_readiness_status?:
            | "retail_ready"
            | "needs_attention"
            | "blocked"
            | "processing"
            | "awaiting_review";
          sale_price?: number | null;
          series?: string | null;
          source_external_id?: string | null;
          source_metadata?: Json;
          source_provider?: string | null;
          status?: string | null;
          stock_number?: string | null;
          tagline?: string | null;
          transmission?: string | null;
          trim?: string | null;
          updated_at?: string;
          vin?: string | null;
          warranty_type?: string | null;
          year?: number | null;
          msrp?: number | null;
        };
        Update: {
          assigned_photographer_id?: string | null;
          body_class?: string | null;
          category?: string | null;
          certification_program?: string | null;
          comments?: string | null;
          condition?: string | null;
          created_at?: string;
          custom_comments?: string | null;
          cylinders?: number | null;
          dealership_id?: string;
          drivetrain?: string | null;
          engine?: string | null;
          exterior_color?: string | null;
          fuel_type?: string | null;
          id?: string;
          interior_color?: string | null;
          internal_notes?: string | null;
          internet_price?: number | null;
          inventory_arrival_date?: string | null;
          inventory_type?: "new" | "used" | "certified" | null;
          make?: string | null;
          model?: string | null;
          odometer?: number | null;
          price?: number | null;
          price_description?: string | null;
          publication_description?: string | null;
          publication_state?: "disabled" | "pending" | "publishing" | "published" | "failed";
          retail_readiness_status?:
            | "retail_ready"
            | "needs_attention"
            | "blocked"
            | "processing"
            | "awaiting_review";
          sale_price?: number | null;
          series?: string | null;
          source_external_id?: string | null;
          source_metadata?: Json;
          source_provider?: string | null;
          status?: string | null;
          stock_number?: string | null;
          tagline?: string | null;
          transmission?: string | null;
          trim?: string | null;
          updated_at?: string;
          vin?: string | null;
          warranty_type?: string | null;
          year?: number | null;
          msrp?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "vehicles_dealership_id_fkey";
            columns: ["dealership_id"];
            isOneToOne: false;
            referencedRelation: "dealerships";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_invitation: { Args: { _token: string }; Returns: Json };
      associate_bulk_photo_session: {
        Args: { _session_id: string; _vehicle_id: string };
        Returns: Database["public"]["Tables"]["photo_capture_sessions"]["Row"];
      };
      complete_photo_capture_session: {
        Args: { _session_id: string };
        Returns: Database["public"]["Tables"]["photo_capture_sessions"]["Row"];
      };
      commit_photo_variant: {
        Args: {
          _image_url: string;
          _photo_id: string;
          _processing_provider?: string | null;
          _storage_path?: string | null;
          _variant_type: string;
        };
        Returns: Database["public"]["Tables"]["media_variants"]["Row"];
      };
      create_payout_rule: {
        Args: {
          _amount: number;
          _config?: Json;
          _dealership_id: string;
          _effective_from?: string;
          _name: string;
          _task_type: string;
        };
        Returns: Database["public"]["Tables"]["payout_rules"]["Row"];
      };
      create_manual_payout_adjustment: {
        Args: {
          _amount: number;
          _dealership_id: string;
          _employee_id: string;
          _reason: string;
          _work_date?: string;
        };
        Returns: Database["public"]["Tables"]["payout_entries"]["Row"];
      };
      disable_payout_rule: {
        Args: { _rule_id: string };
        Returns: Database["public"]["Tables"]["payout_rules"]["Row"];
      };
      get_capture_session_completeness: {
        Args: { _session_id: string };
        Returns: Json;
      };
      get_current_user_store_capabilities: {
        Args: { _dealership_id: string };
        Returns: Json;
      };
      get_daily_activity_report: {
        Args: { _dealership_id: string; _from_date: string; _to_date: string };
        Returns: {
          completed_at: string | null;
          created_by: string | null;
          duration_seconds: number | null;
          id: string;
          photo_count: number;
          video_count: number;
        }[];
      };
      get_production_payout_report: {
        Args: {
          _dealership_id: string;
          _from_date: string;
          _status?: string | null;
          _to_date: string;
        };
        Returns: {
          amount: number;
          completed_at: string | null;
          duration_seconds: number | null;
          employee_id: string;
          employee_name: string;
          payout_id: string;
          payout_status: string;
          photo_count: number;
          photo_shoot_id: string | null;
          review_status: string;
          started_at: string | null;
          stock_number: string;
          task_type: string;
          vehicle_id: string | null;
          vehicle_name: string;
          video_count: number;
          vin: string;
          work_date: string;
        }[];
      };
      list_payout_eligible_profiles: {
        Args: { _dealership_id: string };
        Returns: {
          email: string;
          full_name: string | null;
          profile_id: string;
        }[];
      };
      generate_vehicle_document: {
        Args: { _document_type: string; _vehicle_id: string };
        Returns: Database["public"]["Tables"]["generated_documents"]["Row"];
      };
      refresh_vehicle_readiness: {
        Args: { _vehicle_id: string };
        Returns: Database["public"]["Tables"]["vehicle_readiness"]["Row"];
      };
      reorder_vehicle_gallery: {
        Args: { _items: Json; _vehicle_id: string };
        Returns: Json;
      };
      reorder_bulk_photo_items: {
        Args: { _item_ids: string[]; _session_id: string };
        Returns: undefined;
      };
      save_document_requirements: {
        Args: { _dealership_id: string; _requirements: Json };
        Returns: undefined;
      };
      save_media_processing_configuration: {
        Args: { _dealership_id: string; _rules: Json };
        Returns: undefined;
      };
      save_photography_configuration: {
        Args: { _completion_policy: string; _dealership_id: string; _shots: Json };
        Returns: undefined;
      };
      save_readiness_configuration: {
        Args: { _dealership_id: string; _rules: Json };
        Returns: undefined;
      };
      set_vehicle_primary_asset: {
        Args: { _asset_id: string; _asset_type: string; _vehicle_id: string };
        Returns: Json;
      };
      set_bulk_primary_item: {
        Args: { _item_id: string; _session_id: string };
        Returns: undefined;
      };
      set_payout_status: {
        Args: { _payout_id: string; _status: string };
        Returns: Database["public"]["Tables"]["payout_entries"]["Row"];
      };
      start_photo_capture_session: {
        Args: {
          _dealership_id: string;
          _mode?: string;
          _vehicle_id?: string | null;
          _vin?: string | null;
        };
        Returns: Database["public"]["Tables"]["photo_capture_sessions"]["Row"];
      };
      begin_temporary_password_reset_operation: {
        Args: { _actor_id: string; _idempotency_key: string; _target_profile_id: string };
        Returns: Json;
      };
      begin_user_provisioning_operation: {
        Args: {
          _actor_id: string;
          _dealership_ids: string[];
          _email: string;
          _full_name: string;
          _idempotency_key: string;
          _role: Database["public"]["Enums"]["app_role"];
        };
        Returns: Json;
      };
      complete_temporary_password_onboarding: {
        Args: { _actor_id: string };
        Returns: undefined;
      };
      contain_temporary_password_reset_operation: {
        Args: { _actor_id: string; _operation_id: string; _safe_error_code: string };
        Returns: undefined;
      };
      finalize_temporary_password_reset_operation: {
        Args: { _actor_id: string; _operation_id: string };
        Returns: Json;
      };
      finalize_user_provisioning_operation: {
        Args: { _actor_id: string; _auth_user_id: string; _operation_id: string };
        Returns: Json;
      };
      mark_user_account_operation: {
        Args: {
          _actor_id: string;
          _operation_id: string;
          _safe_error_code?: string;
          _status: string;
          _target_profile_id?: string;
        };
        Returns: undefined;
      };
      admin_set_platform_setting: {
        Args: { _actor_id: string; _setting_key: string; _setting_value: Json };
        Returns: undefined;
      };
      admin_set_dealership_setting: {
        Args: {
          _actor_id: string;
          _dealership_id: string;
          _read_scope?: string;
          _setting_key: string;
          _setting_value: Json;
        };
        Returns: undefined;
      };
      enqueue_background_job: {
        Args: {
          _job_type: string;
          _payload?: Json;
          _dealership_id?: string;
          _dedupe_key?: string;
          _trace_id?: string;
          _max_attempts?: number;
          _priority?: number;
          _created_by?: string;
        };
        Returns: Json;
      };
      worker_claim_background_job: {
        Args: { _worker_id: string; _lease_seconds?: number };
        Returns: Json;
      };
      worker_heartbeat_background_job: {
        Args: { _worker_id: string; _job_id: string; _lease_seconds?: number };
        Returns: boolean;
      };
      worker_complete_background_job: {
        Args: { _worker_id: string; _job_id: string; _safe_result?: Json };
        Returns: boolean;
      };
      worker_fail_background_job: {
        Args: {
          _worker_id: string;
          _job_id: string;
          _safe_error_code: string;
          _retryable?: boolean;
        };
        Returns: string;
      };
      worker_get_queue_metrics: { Args: Record<PropertyKey, never>; Returns: Json };
      admin_update_user_account_access: {
        Args: {
          _actor_user_id: string;
          _dealership_ids: string[];
          _full_name: string;
          _role: Database["public"]["Enums"]["app_role"];
          _target_user_id: string;
        };
        Returns: undefined;
      };
      admin_set_user_activation: {
        Args: { _actor_id: string; _status: string; _target_profile_id: string };
        Returns: undefined;
      };
      check_invitation_account_exists: {
        Args: { _token: string };
        Returns: boolean;
      };
      get_invitation_details: {
        Args: { _token: string };
        Returns: {
          dealership_id: string;
          dealership_name: string;
          email: string;
          expires_at: string;
          full_name: string;
          id: string;
          role: string;
          status: string;
        }[];
      };
      get_user_dealership: { Args: { _user_id: string }; Returns: string };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: {
      app_role: "owner" | "dealer_admin" | "staff";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "dealer_admin", "staff"],
    },
  },
} as const;
