const mongoose = require('mongoose');

// إحصائيات لاعب في مباراة واحدة. stats = حقول قالب رياضة المباراة
// (utils/matchStatsCatalog) بعد التنظيف.
const matchStatSchema = new mongoose.Schema(
  {
    academyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Academy', required: true },
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    sport: { type: String, trim: true, default: '' },
    templateKey: { type: String, required: true },
    matchDate: { type: Date, default: null },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },
    rating: { type: Number, min: 0, max: 10, default: null },
    mvp: { type: Boolean, default: false },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    minimize: false,
    toJSON: {
      transform(doc, ret) {
        ret._id = ret._id.toString();
        ret.academyId = ret.academyId?.toString();
        ret.matchId = ret.matchId?._id ? ret.matchId : ret.matchId?.toString();
        ret.playerId = ret.playerId?.toString();
        delete ret.__v;
        return ret;
      },
    },
  }
);

matchStatSchema.index({ matchId: 1, playerId: 1 }, { unique: true });
matchStatSchema.index({ academyId: 1, sport: 1, playerId: 1 });
matchStatSchema.index({ playerId: 1, matchDate: -1 });

module.exports = mongoose.model('MatchStat', matchStatSchema);
