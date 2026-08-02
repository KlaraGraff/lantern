use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{tool, tool_router, ErrorData};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::commands::language_assessments;
use crate::mcp::server::LanternMcpHandler;
use crate::mcp::tools::annotations_write::{validate_ids, DeleteIdsArgs};
use crate::mcp::tools::library::require_sync;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SaveLanguageAssessmentArgs {
    /// Supported exam type: `ielts`, `toefl_ibt`, `toeic_lr`, `cambridge`, `det`, `cet4`, or `cet6`.
    pub exam_type: String,
    pub overall_score: f64,
    #[serde(default)]
    pub reading_score: Option<f64>,
    /// Optional exam date in `YYYY-MM-DD` format.
    #[serde(default)]
    pub exam_date: Option<String>,
}

#[tool_router(router = assessments_write_router, vis = "pub(crate)")]
impl LanternMcpHandler {
    #[tool(
        description = "Save a language exam assessment and return Lantern's CEFR estimate. This local calculation does not call an AI service."
    )]
    pub async fn save_language_assessment(
        &self,
        Parameters(SaveLanguageAssessmentArgs {
            exam_type,
            overall_score,
            reading_score,
            exam_date,
        }): Parameters<SaveLanguageAssessmentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        require_sync(self)?;
        let assessment = language_assessments::save_language_assessment_in(
            &self.state.db,
            exam_type,
            overall_score,
            reading_score,
            exam_date,
        )
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("language_assessments", "updated", &assessment.id);
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &assessment,
        )?]))
    }

    #[tool(
        description = "Permanently delete one or more language assessment records. This action cannot be undone."
    )]
    pub async fn delete_language_assessments(
        &self,
        Parameters(DeleteIdsArgs { ids }): Parameters<DeleteIdsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids = validate_ids(ids, "ids")?;
        require_sync(self)?;
        let deleted = language_assessments::delete_language_assessments_in(&self.state.db, &ids)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        self.state
            .notify("language_assessments", "deleted", &deleted.to_string());
        Ok(CallToolResult::success(vec![ContentBlock::json(
            &serde_json::json!({ "requested": ids.len(), "deleted": deleted }),
        )?]))
    }
}
