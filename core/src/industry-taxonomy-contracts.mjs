export const INDUSTRY_TAXONOMY_VERSION = 9;

const MEDICAL_DEVICE_SIGNAL_RE = /医疗器械|医疗科技|医用设备|医疗设备|医械|医药|药业|药企|制药|药品|药品包装|药品品牌|制药企业|临床|医护|医院|康复设备|诊断|检验|体外诊断|IVD|耗材|生命科学|医疗服务|医疗软件|临床软件|病历系统|临床问卷|FHIR|SDC|medical device|medtech|pharma|pharmaceutical|medicine packaging|healthcare technology|clinical|diagnostic|FHIR questionnaire|clinical software/i;
const AI_RESEARCH_SOFTWARE_SIGNAL_RE = /人工智能|AI平台|AI软件|大模型|智能体|智能客服|知识库|算法平台|数据智能|模型服务|Claude|Anthropic|OpenAI|LLM|machine learning|AI agent|research software|knowledge management/i;
const GENERAL_TECHNOLOGY_B2B_SIGNAL_RE = /科技公司|科技企业|信息技术|数字科技|数字化|软件系统|软件平台|企业软件|SaaS|云平台|云服务|数据平台|智能系统|智能硬件|物联网|IoT|工业互联网|技术服务|系统集成|开发者工具|研发平台|enterprise software|software platform|SaaS|cloud platform|digital platform|IoT|smart hardware|technology company/i;
const CONSUMABLE_FOOD_PACKAGING_SIGNAL_RE = /巧克力|糖果|茶油|食用油|粮油|食品|零食|糕点|烘焙|底料|速冻|水饺|茶叶|饮料|饮品|豆腐|年糕|蔬菜|农特|农副产品|罐头|腊肉|西红柿|礼盒包装|食品包装|包装袋/i;
const EV_ELECTRICAL_COMPONENT_SIGNAL_RE = /busbar|汇流排|母排|铜排|大端子|端子|接线端子|连接器|接插件|电连接|电连接件|电连接用|电气连接|线束|高压连接|连接零部件|新能源(?:汽车)?零部件/i;
const FINANCIAL_INSURANCE_SIGNAL_RE = /金融|银行|保险|财险|寿险|理财|基金|证券|支付|贷款|信贷|征信|担保|保理|融资租赁|资产管理|财富管理|风控|交易台|监管科技|核心账务|保单|理赔单|financial|finance|bank|banking|insurance|fintech|regtech|trading blotter|payment|loan|credit|wealth management|asset management/i;
const GENERAL_BUSINESS_SEMANTIC_CUE_RE = /互联网企业|本地生活|生活服务|商业服务|企业服务|电子商务|电商|商城|智能营销|营销服务|流量解决方案|品牌服务|门店运营|服务商|连锁服务|零售服务|贸易服务|咨询服务|管理服务|(?:本地生活|爆品|商城|营销|流量|生活服务).{0,8}平台|平台.{0,8}(?:本地生活|爆品|商城|营销|流量|生活服务)/i;
const KEEPSAKE_ILLUSTRATION_SIGNAL_RE = /国风|生肖|蛇主题|插画|工笔画|写意|祥云|竹叶|手脚印相框|手足印相框|宝宝相框|儿童相框|纪念相框|相框产品|主图|illustration|keepsake frame/i;
const REAL_HOME_FURNITURE_SIGNAL_RE = /床垫|寝具|软床|沙发|家具(?:设计|品牌|家居)?|木作|定制家居|全屋定制|床品|mattress|bedding|sofa|furniture/i;

export const INDUSTRY_DEFS = Object.freeze([
  {
    id: 'agriculture_fertilizer',
    label: '农业 / 粮油 / 农资',
    domain: 'agriculture',
    weight: 90,
    patterns: [/农业|农资|肥料|种植|作物|土壤|丰收|农场|有机肥|水溶肥|农药|饲料|林业|牧业|粮食|粮油|粮仓|谷物|稻谷|稻穗|食用油|农产品|农特|农副产品|蔬菜/],
    promptHints: ['ground the design in agricultural trust, crop/grain vitality, field/storage context, and durable supply-chain visibility'],
    visualCues: ['crop/grain vitality', 'field or storage context', 'grain/oil package or depot application', 'robust trustworthy mark'],
    applicationContexts: ['grain depot sign', 'oil/grain package', 'woven bag or carton', 'dealer storefront', 'field signage'],
    materialCues: ['durable print', 'high-contrast label', 'outdoor-readable color'],
    forbiddenCliches: ['generic tech circuit patterns', 'luxury fashion styling', 'fake organic certifications'],
    qaFocus: ['industry reads as agriculture/grain-oil supply, not generic green logo', 'mark remains readable on oil barrel/rice bag/carton applications'],
  },
  {
    id: 'semiconductor_electronics',
    label: '半导体 / 芯片 / 电子科技',
    domain: 'advanced_technology',
    weight: 92,
    patterns: [/半导体|芯片|晶圆|集成电路|IC\b|电子科技|微电子|封装测试|光刻|硅片|wafer|semiconductor|chip/i],
    promptHints: ['use precise semiconductor/wafer/circuit language, restrained enterprise-tech tone, and original geometry rather than obvious AI gloss'],
    visualCues: ['wafer geometry', 'circuit trace discipline', 'precision grid', 'cool technical palette'],
    applicationContexts: ['enterprise signage', 'clean-room card', 'chip/wafer presentation', 'website/app icon'],
    materialCues: ['matte metal', 'glass/acrylic', 'clean technical print'],
    forbiddenCliches: ['AI robot head', 'generic neon brain', 'random circuit wallpaper', 'crypto/web3 look'],
    qaFocus: ['reads as semiconductor enterprise, not generic internet tech', 'letterforms stay controlled and original'],
  },
  {
    id: 'ev_electrical_components_b2b',
    label: '新能源电连接件 / Busbar / 连接器 B2B',
    domain: 'ev_electrical_components_b2b',
    weight: 98,
    patterns: [EV_ELECTRICAL_COMPONENT_SIGNAL_RE],
    promptHints: ['treat the brief as an EV electrical-connection component manufacturer: precision busbar/terminal/connector engineering, export-ready B2B credibility, and product-spec proof instead of charging-station/operator visuals'],
    visualCues: ['precision copper busbar or terminal geometry', 'engineered connection path', 'clean export manufacturing identity', 'controlled blue/copper technical palette'],
    applicationContexts: ['factory entrance sign', 'busbar/terminal product catalog', 'component nameplate or label', 'trade-show booth', 'datasheet/spec cover'],
    materialCues: ['copper or plated metal', 'insulating plastic', 'machined component detail', 'matte industrial print'],
    forbiddenCliches: ['charging station/operator identity unless the buyer asks for it', 'generic EV car silhouette', 'leaf-only green energy mark', 'random circuit-board wallpaper', 'consumer charging-app styling'],
    qaFocus: ['reads as EV electrical components / connector manufacturing B2B', 'application proof includes product/catalog/factory/spec-sheet contexts rather than only station or vehicle scenes'],
  },
  {
    id: 'ai_research_software_b2b',
    label: 'AI / 研究型软件 / 知识科技 B2B',
    domain: 'ai_research_software_b2b',
    weight: 90,
    patterns: [AI_RESEARCH_SOFTWARE_SIGNAL_RE],
    promptHints: ['treat the brief as AI/research software or knowledge-tech identity: product credibility, documentation clarity, and original system language without copying Claude/Anthropic'],
    visualCues: ['calm AI product credibility', 'documentation/product UI proof', 'research-grade hierarchy', 'warm technical restraint'],
    applicationContexts: ['AI product dashboard', 'developer console', 'research report cover', 'documentation portal', 'enterprise deck'],
    materialCues: ['screen UI', 'editorial report paper', 'documentation page', 'controlled product diagram'],
    forbiddenCliches: ['Claude/Anthropic lookalike styling', 'robot head', 'neon brain', 'generic chatbot bubble', 'fake AI benchmark/safety claim'],
    qaFocus: ['reads as AI/research software B2B, not generic SaaS filler', 'does not imitate Claude/Anthropic brand assets', 'application proof includes product UI, documentation, or research context'],
  },
  {
    id: 'general_technology_b2b',
    label: '科技企业 / 软件平台 / 智能硬件 B2B',
    domain: 'general_technology_b2b',
    weight: 85,
    patterns: [GENERAL_TECHNOLOGY_B2B_SIGNAL_RE],
    promptHints: ['treat the brief as a mature technology company identity: exact wordmark trust first, one ownable technical idea, and product/application proof without blue-purple template gloss'],
    visualCues: ['credible technology wordmark', 'single system motif', 'product or platform application proof', 'restrained premium technical palette'],
    applicationContexts: ['enterprise website header', 'product dashboard or console', 'app icon', 'lobby sign', 'deck cover', 'hardware/device label when relevant'],
    materialCues: ['matte graphite or white UI surface', 'subtle electric-blue/green accent', 'acrylic or metal sign', 'clean product screen'],
    forbiddenCliches: ['blue-purple gradient tech template', 'random circuit wallpaper', 'stacked chip/cloud/AI/hexagon/globe symbols', 'neon glow as the logo itself', 'fake English or slogan text'],
    qaFocus: ['reads as a real technology brand, not a generic template', 'exact wordmark remains primary and legible', 'application proof is industry-specific and not empty stationery'],
  },
  {
    id: 'food_beverage_restaurant',
    label: '餐饮 / 食品 / 饮品',
    domain: 'food_service',
    weight: 86,
    patterns: [/餐饮|餐厅|饭店|快餐|小吃|火锅|烧烤|咖啡|茶饮|奶茶|食品|零食|糕点|烘焙|巧克力|糖果|茶油|食用油|底料|速冻|水饺|调味|茶叶|酒|饮品|豆腐|年糕|蔬菜|农特|农副产品|罐头|腊肉|西红柿|家常菜|food|restaurant|bbq|coffee/i],
    promptHints: ['make the identity appetizing, storefront-ready, and operationally legible across menu, packaging, and signage'],
    visualCues: ['warm appetite palette', 'menu/signage hierarchy', 'packaging/takeaway proof'],
    applicationContexts: ['storefront sign', 'menu', 'takeaway bag/cup', 'staff uniform'],
    materialCues: ['food-safe packaging', 'warm lighting', 'clean counter materials'],
    forbiddenCliches: ['overly abstract luxury mark without appetite', 'fake awards', 'unreadable menu microtext'],
    qaFocus: ['food category is visible', 'brand works on storefront/menu/packaging'],
  },
  {
    id: 'hospitality_hotel_tourism',
    label: '酒店 / 文旅 / 民宿',
    domain: 'hospitality',
    weight: 84,
    patterns: [/酒店|民宿|客栈|文旅|度假|景区|旅游|旅居|温泉|resort|hotel|hospitality/i],
    promptHints: ['balance local culture, hospitality comfort, and premium but calm guest experience'],
    visualCues: ['place-specific motif', 'calm premium hospitality palette', 'wayfinding/application suite'],
    applicationContexts: ['hotel sign', 'room card', 'amenities', 'wayfinding', 'reservation page'],
    materialCues: ['wood/stone/paper texture', 'quiet metal accents', 'soft lighting'],
    forbiddenCliches: ['generic luxury gold seal', 'overcrowded tourist collage'],
    qaFocus: ['has hotel/hospitality temperament', 'local cues are integrated not pasted on'],
  },
  {
    id: 'sports_fitness_outdoor',
    label: '运动 / 健身 / 户外',
    domain: 'sports',
    weight: 82,
    patterns: [/运动|健身|户外运动|户外用品|户外装备|高尔夫|拳击|球杆|瑜伽|骑行|露营|卡丁车|体育|golf|boxing|fitness|outdoor|sport/i],
    promptHints: ['show kinetic energy, equipment/use context, and category-specific proportions instead of generic sporty stripes'],
    visualCues: ['motion line discipline', 'equipment silhouette', 'performance material cues'],
    applicationContexts: ['equipment', 'apparel', 'club/event sign', 'packaging'],
    materialCues: ['rubber/fabric/leather/technical shell', 'high-friction detail'],
    forbiddenCliches: ['random speed flames', 'generic gym badge if the sport is specific'],
    qaFocus: ['sport category is unmistakable', 'equipment/application scale is credible'],
  },
  {
    id: 'pet_toy_character_product',
    label: '宠物 / 玩具 / 角色产品',
    domain: 'pet_toy_character_product',
    weight: 78,
    patterns: [/宠物用品|宠物|牵引绳|毛绒|公仔|玩具|潮玩|盲盒|手办|玩偶|IP形象|卡通形象|plush|toy|figure|pet product/i],
    promptHints: ['treat the brief as a product or character-object design problem: keep the creature/character readable, manufacturable, and emotionally clear without drifting into generic mascot art'],
    visualCues: ['friendly character silhouette', 'toy/product scale proof', 'soft material or molded product cues', 'packaging or use-context proof'],
    applicationContexts: ['product render', 'package front', 'hangtag/label', 'ecommerce tile', 'character pose sheet'],
    materialCues: ['plush fabric', 'soft plastic', 'molded toy surface', 'pet-safe material cue'],
    forbiddenCliches: ['random cute mascot unrelated to product use', 'unsafe pet-product claims', 'overly complex character that cannot be manufactured'],
    qaFocus: ['product or character use is clear', 'scale/material proof is credible', 'does not become a generic logo mascot when product design is required'],
  },
  {
    id: 'ceramic_decal_character_design',
    label: '日用陶瓷贴花 / 原创卡通形象',
    domain: 'ceramic_decal_character_ip',
    weight: 98,
    patterns: [/陶瓷贴花|陶瓷(?:类)?产品.{0,20}卡通|日用品陶瓷|陶瓷杯|马克杯|杯子.{0,12}卡通|平面卡通|卡通形象.{0,20}英文名|男孩.{0,16}女孩.{0,16}卡通|女孩.{0,16}男孩.{0,16}卡通|欧美儿童|青少年.{0,12}卡通|decal|ceramic decal/i],
    promptHints: ['treat the brief as original flat character IP for ceramic decal use: two readable characters, print-safe simple silhouettes, English names, and ceramic application proof kept secondary'],
    visualCues: ['flat cute character sheet', 'girl/boy role distinction', 'English character names', 'ceramic-safe decal palette', 'small mug/bowl proof only as usage context'],
    applicationContexts: ['character sheet', 'small mug or bowl decal proof', 'wraparound decal band', 'palette and outline proof'],
    materialCues: ['flat decal colors', 'clean contour line art', 'glossy ceramic mockup as secondary proof'],
    forbiddenCliches: ['furniture showroom or mattress label route', 'logo/VI board', 'ceramic cup as the main hero object', 'packaging-only board', 'copied famous cartoon/IP style'],
    qaFocus: ['two original characters are the main subject', 'girl-oriented calm role and boy-oriented playful role are both clear', 'English names are visible', 'ceramic application proof is secondary and credible'],
  },
  {
    id: 'fashion_apparel_accessories',
    label: '服装 / 时尚 / 配饰',
    domain: 'fashion',
    weight: 80,
    patterns: [/服装|服饰|服饰定制|女装|男装|羽绒服|T\s*恤|Polo\s*衫|围裙|印花定制|鞋帽|箱包|配饰|饰品|首饰|珠宝|饰品盒|首饰盒|礼品盒|吊牌|领标|潮牌|fashion|apparel|clothing|garment|jewelry/i],
    promptHints: ['prioritize refined typography, premium product-catalog hierarchy, accessory/jewelry packaging proof, and brand taste over noisy symbols'],
    visualCues: ['controlled luxury typography', 'accessory/jewelry box product photography', 'editorial catalog restraint'],
    applicationContexts: ['product catalog cover', 'jewelry/accessory box spread', 'packaging detail page', 'sales handout', 'ecommerce tile'],
    materialCues: ['foil-stamped cover', 'embossed paper', 'matte black/white/gold print', 'premium box texture'],
    forbiddenCliches: ['overly corporate tech grid', 'cheap clip-art clothing icon', 'random crown/luxury monogram cliche'],
    qaFocus: ['works as a fashion/accessory product catalog when workflow is catalog_brochure', 'typography feels controlled and premium'],
  },
  {
    id: 'home_furniture_bedding',
    label: '家居 / 家具 / 床垫',
    domain: 'home_furnishing',
    weight: 84,
    patterns: [/家具|家居|床垫|寝具|软床|沙发|木作|定制家居|手工床垫|mattress|furniture|bedding|home furnishing/i],
    promptHints: ['make the identity feel calm, premium, tactile, and home-ready with credible furniture or mattress applications'],
    visualCues: ['soft premium wordmark', 'bedroom/showroom application', 'fabric/wood material cue', 'quiet high-end palette'],
    applicationContexts: ['showroom sign', 'mattress label', 'bedroom scene', 'hangtag/care card', 'delivery packaging'],
    materialCues: ['woven label', 'matte paper hangtag', 'wood/fabric showroom surface', 'soft textile emboss'],
    forbiddenCliches: ['cheap generic house icon', 'overly tech/SaaS look', 'random leaf-only bedding mark', 'fake luxury crest'],
    qaFocus: ['brand feels furniture/bedding premium rather than generic business', 'logo works on mattress label/showroom/package'],
  },
  {
    id: 'home_improvement_decoration',
    label: '家装 / 装修 / 装饰服务',
    domain: 'home_improvement_service',
    weight: 90,
    patterns: [/家装|装修公司|装饰公司|室内装修|家装品牌|软装|硬装|全屋定制|装企|home improvement|renovation/i],
    promptHints: ['treat home-renovation logo briefs as service-brand identity/VI work, not landscape/public-art or interior-render proposal boards unless the workflow itself is spatial design'],
    visualCues: ['trustworthy home-service identity', 'construction/craft detail', 'residential application proof', 'clean service signage'],
    applicationContexts: ['storefront sign', 'vehicle/workwear decal', 'business card', 'site protection board', 'residential service brochure'],
    materialCues: ['matte signage', 'paper/card print', 'workwear/decal surfaces', 'clean residential texture used as support'],
    forbiddenCliches: ['landscape/public-art render pack for a logo brief', 'generic house roof icon only', 'overbuilt interior render replacing brand identity'],
    qaFocus: ['logo/VI remains the deliverable when the model workflow is logo_brand', 'applications fit home-improvement service touchpoints'],
  },
  {
    id: 'property_facility_real_estate_service',
    label: '物业 / 楼宇 / 地产服务',
    domain: 'property_facility_service',
    weight: 78,
    patterns: [/物业|楼盘|楼宇|地产|房产|小区|园区|社区商业|商业管理|资产管理|设施管理|招商运营|property|real estate|facility/i],
    promptHints: ['treat the brief as a property/facility service brand unless it explicitly asks for space/landscape proposal boards'],
    visualCues: ['reliable property-service identity', 'building/facility touchpoint proof', 'community or asset-management clarity'],
    applicationContexts: ['building lobby sign', 'property service desk', 'vehicle/workwear decal', 'document header', 'community notice board'],
    materialCues: ['architectural sign material', 'durable service print', 'clean document system'],
    forbiddenCliches: ['luxury real-estate sales poster when the brief is property service', 'generic skyline icon only', 'forcing spatial render output for a logo/VI brief'],
    qaFocus: ['reads as property/facility service or real-estate operations', 'does not drift into landscape/interior proposal unless workflow requires it'],
  },
  {
    id: 'financial_insurance_service',
    label: '金融 / 保险 / 支付服务',
    domain: 'financial_insurance_service',
    weight: 86,
    patterns: [FINANCIAL_INSURANCE_SIGNAL_RE],
    promptHints: ['treat finance, insurance, payment, and wealth-service briefs as regulated service identities with logo/VI-led trust, document/app proof, and no fake authority'],
    visualCues: ['regulated service trust', 'clear logo/wordmark hierarchy', 'secure document or statement proof', 'restrained financial palette', 'risk/data competence kept secondary'],
    applicationContexts: ['financial service app dashboard', 'insurance policy or claim document', 'customer service portal', 'statement or card surface', 'advisor presentation or branch sign', 'risk report or trading blotter crop'],
    materialCues: ['clean document paper', 'secure card/statement surface', 'white/blue service UI', 'restrained civic accent', 'matte branch signage'],
    forbiddenCliches: ['fake bank or government seal', 'fake compliance/license badge', 'guaranteed return claim', 'invented APY/ROI/license number', 'crypto/Web3 speculation unless explicitly requested'],
    qaFocus: ['reads as finance/insurance/regulated service', 'logo/VI remains primary instead of a generic dashboard screenshot', 'forms/documents/data proof is legible and not filler', 'no invented regulatory authority or return guarantee'],
  },
  {
    id: 'medical_device_healthcare_b2b',
    label: '医疗器械 / 医疗科技 / 医疗服务 B2B',
    domain: 'medical_device_healthcare_b2b',
    weight: 96,
    patterns: [MEDICAL_DEVICE_SIGNAL_RE],
    promptHints: ['treat the brief as regulated healthcare technology: clinical trust, engineering precision, patient-care warmth, and LOGO/VI-led application proof'],
    visualCues: ['clinical-grade clarity', 'device/software application proof', 'precise but human mark', 'calm healthcare technology palette', 'clinical forms or FHIR proof kept secondary'],
    applicationContexts: ['hospital or clinic signage', 'medical device nameplate', 'diagnostic/lab interface', 'IFU/manual cover', 'FHIR/clinical intake form preview', 'sales catalog or trade-show booth'],
    materialCues: ['sterile white/soft gray surfaces', 'medical device plastic/metal', 'clean screen UI', 'clinical packaging or documentation stock', 'print-safe IFU label stock'],
    forbiddenCliches: ['red-cross/caduceus main symbol unless legally required', 'generic heart/leaf/hand wellness icon', 'fake certification or treatment claim', 'invented patient/diagnosis/approval data', 'old/source logo geometry reuse'],
    qaFocus: ['reads as medical device or healthcare technology B2B, not beauty/wellness or generic industrial', 'logo/VI remains primary instead of a clinical UI mockup', 'old logo attachment is not reused for brand-new briefs', 'no fake regulatory/clinical claims'],
  },
  {
    id: 'beauty_health_wellness',
    label: '美业 / 健康 / 营养',
    domain: 'health_wellness',
    weight: 82,
    patterns: [/美容|美业|护肤|医美|健康|营养|保健|滴剂|精油|护理|养生|个人护理|日化|日用品|棉签|棉棒|卫生用品|洗护|wellness|beauty|supplement|nutrition/i],
    promptHints: ['keep the design clean, trustworthy, hygienic, and premium without making medical/legal claims'],
    visualCues: ['clean natural premium mark', 'bottle/label proof', 'soft clinical palette'],
    applicationContexts: ['bottle label', 'clinic/storefront', 'package', 'social tile'],
    materialCues: ['frosted glass', 'white label stock', 'soft metallic accent'],
    forbiddenCliches: ['fake medical certification', 'pharma overclaim', 'jewelry/candy look for supplements'],
    qaFocus: ['health/beauty trust is clear', 'no medical guarantee or fake certification'],
  },
  {
    id: 'energy_ev_infrastructure',
    label: '新能源 / 换电 / 基础设施',
    domain: 'energy_infrastructure',
    weight: 84,
    patterns: [/新能源|换电|充电|电池|储能|光伏|风电|重卡|能源|电站|电力|电动车|摩托车|车灯|LED(?:灯|照明)?|EV\b|battery|charging/i],
    promptHints: ['show infrastructure reliability, energy circulation, station/network logic, and industrial-grade technology'],
    visualCues: ['energy loop', 'station/network system', 'industrial tech palette'],
    applicationContexts: ['station signage', 'vehicle decal', 'operator dashboard', 'safety sign'],
    materialCues: ['industrial metal', 'reflective safety material', 'screen UI'],
    forbiddenCliches: ['consumer phone-app look only', 'generic green leaf without infrastructure'],
    qaFocus: ['reads as energy infrastructure, not ordinary electronics', 'application proof includes station/vehicle/network'],
  },
  {
    id: 'automotive_trade_mobility',
    label: '汽车 / 汽配 / 出行贸易',
    domain: 'automotive_mobility',
    weight: 78,
    patterns: [/汽车|汽配|整车|二手车|车企|车品|车载|轮胎|改装|外贸车|出口车|汽车贸易|车务|automotive|auto parts|vehicle trade|mobility/i],
    promptHints: ['use automotive trade and mobility-service cues with durable showroom, livery, catalog, and export-trade proof'],
    visualCues: ['vehicle silhouette or parts context kept secondary to brand', 'showroom/export-trade credibility', 'mobility service system'],
    applicationContexts: ['showroom sign', 'vehicle decal', 'parts package', 'catalog/spec sheet', 'trade booth'],
    materialCues: ['automotive paint/metal', 'durable vinyl decal', 'catalog paper', 'parts packaging'],
    forbiddenCliches: ['generic speed flames', 'racing look for ordinary trade/export service', 'green energy claim unless explicitly EV/infrastructure'],
    qaFocus: ['reads as automotive trade/mobility, not generic industrial or energy infrastructure', 'application proof includes vehicle/showroom/parts/trade context'],
  },
  {
    id: 'aviation_transport_service',
    label: '航空 / 交通 / 高端服务',
    domain: 'transport_aviation',
    weight: 88,
    patterns: [/航空|航司|飞机|机场|飞行|航线|通航|无人机|空运|物流航空|aviation|airline|aircraft|flight/i],
    promptHints: ['show aviation reliability, upward motion, route/network logic, and enterprise-grade service trust without cliché airplane clip-art'],
    visualCues: ['controlled wing/flight geometry', 'route arc or altitude line', 'enterprise service wordmark', 'clean blue/metal technical palette'],
    applicationContexts: ['aircraft or vehicle livery', 'office/signage', 'business card', 'website/app icon', 'document header'],
    materialCues: ['brushed metal', 'aviation blue', 'white cabin/safety material', 'premium matte print'],
    forbiddenCliches: ['generic airplane silhouette pasted above text', 'cartoon wings', 'travel-agency vacation style', 'airport stock-photo collage'],
    qaFocus: ['reads as aviation enterprise/service, not education/media or generic tech', 'brand name remains exact and legible'],
  },
  {
    id: 'government_public_service',
    label: '政府 / 公共服务 / 事业单位',
    domain: 'public_service',
    weight: 82,
    patterns: [/政府|政务|机关|事业单位|公共服务|城市形象|乡村振兴|党建|文化馆|公园|municipal|public service/i],
    promptHints: ['use dignified public-service tone, clear symbolism, accessibility, and official application restraint'],
    visualCues: ['dignified emblem geometry', 'public signage proof', 'clear civic symbolism'],
    applicationContexts: ['public sign', 'document header', 'event banner', 'wayfinding'],
    materialCues: ['stone/metal sign', 'formal print', 'outdoor board'],
    forbiddenCliches: ['commercial luxury styling', 'unofficial coat-of-arms clutter', 'fake government seal'],
    qaFocus: ['public-service dignity and clarity', 'no fake official seal/award'],
  },
  {
    id: 'spatial_retail_exhibition',
    label: '商业空间 / 门店 / 展示',
    domain: 'spatial_design',
    weight: 80,
    patterns: [/门店|店铺|公装|展厅|展场|展览|营销展览|展示区|展示空间|商业展示|展陈|展台|展位|展示柜|展示墙|空间|室内|平面布局|导视|前台|等候区|护理间|retail|interior|exhibition/i],
    promptHints: ['anchor the output in real circulation, functional zones, facade/interior logic, and buildable materials'],
    visualCues: ['facade/interior continuity', 'plan/flow', 'material board', 'signage system'],
    applicationContexts: ['storefront', 'interior overview', 'counter/front desk', 'wayfinding', 'layout plan'],
    materialCues: ['buildable wall/floor/lighting materials', 'signage construction'],
    forbiddenCliches: ['pure mood render without function', 'oversized unrelated landmark concept'],
    qaFocus: ['space function is readable', 'views are not repetitive filler'],
  },
  {
    id: 'landscape_public_art',
    label: '景观 / 公共艺术 / 户外方案',
    domain: 'landscape',
    weight: 94,
    patterns: [/景观|广场设计|广场空间|广场导视|公园|湖景|湖区|湖畔|湖边|滨湖|湖面|湿地|滨水|观景台|庭院|院落|雕塑小品|公共艺术|户外装置|户外广告|广告牌|围挡|外墙|楼宇外墙|landscape|plaza|park/i],
    promptHints: ['lock the site context, circulation, viewing angles, materials, and human scale before decorative atmosphere'],
    visualCues: ['site plan logic', 'human scale', 'material/detail callouts', 'day/night scene'],
    applicationContexts: ['site hero view', 'plan/axon', 'detail node', 'night lighting'],
    materialCues: ['stone/wood/metal/outdoor lighting', 'weatherable finishes'],
    forbiddenCliches: ['floating fantasy structure unrelated to site', 'same-view render repetition'],
    qaFocus: ['site context is respected', 'multiple useful views not duplicates'],
  },
  {
    id: 'industrial_manufacturing_b2b',
    label: '工业制造 / B2B 企业',
    domain: 'industrial_b2b',
    weight: 76,
    patterns: [/制造|生产|研发|机械|工厂|设备|工程|五金|泵业|材料|自动化|工业|车灯|LED(?:灯|照明)?|B2B|manufacturing|machinery|industrial/i],
    promptHints: ['prioritize reliability, engineering precision, structure, and B2B application proof'],
    visualCues: ['engineering geometry', 'equipment/factory application', 'robust wordmark'],
    applicationContexts: ['factory sign', 'equipment plate', 'workwear', 'catalog cover'],
    materialCues: ['metal plate', 'industrial paint', 'machined detail'],
    forbiddenCliches: ['consumer lifestyle styling', 'fragile decorative marks'],
    qaFocus: ['B2B industrial trust is clear', 'applications fit equipment/factory/catalog'],
  },
  {
    id: 'industrial_safety_training',
    label: '工业安全 / 培训手册',
    domain: 'industrial_safety_training',
    weight: 83,
    patterns: [/安全指引|安全手册|高风险作业|作业安全|HSE|施工安全|安全培训|安全教育|安全生产|应急预案|操作规程|safety manual|HSE/i],
    promptHints: ['treat the brief as an industrial safety or training document system: clarity, hierarchy, warning logic, and operational credibility matter more than decorative mood'],
    visualCues: ['safety hierarchy', 'instructional diagram logic', 'industrial warning palette', 'manual/page-system clarity'],
    applicationContexts: ['manual cover', 'instruction spread', 'warning sign', 'training slide', 'site checklist'],
    materialCues: ['print-safe document paper', 'high-contrast signage', 'industrial label material'],
    forbiddenCliches: ['fake certification badge', 'decorative poster that hides instructions', 'unsafe or unclear warning hierarchy'],
    qaFocus: ['instructions and risk hierarchy are readable', 'industrial safety context is credible', 'no fake compliance claims'],
  },
  {
    id: 'education_culture_media',
    label: '教育 / 文化 / 传媒',
    domain: 'education_culture',
    weight: 72,
    patterns: [/教育|学校|培训|课程|文化|传媒|阅读|书店|艺术节|展览|文创|education|culture|media/i],
    promptHints: ['balance clarity, friendliness, cultural meaning, and multi-scene communication use'],
    visualCues: ['editorial/cultural motif', 'event/poster system', 'friendly but structured typography'],
    applicationContexts: ['poster', 'course cover', 'event signage', 'publication/social tile'],
    materialCues: ['paper/editorial texture', 'screen/social layout'],
    forbiddenCliches: ['random graduation cap/book icon unless required', 'busy cultural collage'],
    qaFocus: ['audience and cultural tone are clear', 'system supports communication materials'],
  },
  {
    id: 'general_business_service',
    label: '通用商业 / 服务业',
    domain: 'general_business',
    weight: 20,
    patterns: [/.^/],
    promptHints: ['use the extracted task subject and workflow-specific deliverable rules; avoid generic filler'],
    visualCues: ['subject-specific proof', 'clean business application'],
    applicationContexts: ['signage', 'digital profile', 'presentation or package surface'],
    materialCues: ['neutral production-safe materials'],
    forbiddenCliches: ['generic template look', 'unrelated stock icons'],
    qaFocus: ['industry is not over-claimed when evidence is weak', 'deliverable still matches the brief'],
  },
]);

function normalizeText(text) {
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function excerptAround(text, pattern, max = 180) {
  const match = String(text || '').match(pattern);
  if (!match) return null;
  const index = Math.max(0, match.index || 0);
  const start = Math.max(0, index - Math.floor(max / 3));
  return String(text).slice(start, start + max).replace(/\s+/g, ' ').trim();
}

function evidenceFor(def, text) {
  const evidence = [];
  for (const pattern of def.patterns || []) {
    if (!pattern.test(text)) continue;
    evidence.push({ source: 'title/category/requirement/seller-supplement', signal: def.id, excerpt: excerptAround(text, pattern), weight: def.weight });
  }
  return evidence;
}

function mergeDuplicateMatches(matches = []) {
  const byId = new Map();
  for (const match of matches) {
    const id = match?.def?.id;
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        def: match.def,
        evidence: [...(match.evidence || [])],
        score: Number(match.score || 0),
      });
      continue;
    }
    existing.evidence.push(...(match.evidence || []));
    existing.score += Number(match.score || 0);
  }
  return [...byId.values()];
}

function sanitizeIndustrySignalText(text) {
  return normalizeText(text)
    .split(/[。；;\n]/)
    .filter((chunk) => !/(?:不要|避免|禁用|不能|不接受|拒绝|不得|不可|无需|不用|不需要)/.test(chunk))
    .join('\n');
}

export function industryDefById(industryId) {
  const id = normalizeText(industryId);
  return INDUSTRY_DEFS.find((item) => item.id === id) || null;
}

function specFromIndustryDef(def, {
  confidence = 0.5,
  evidence = [],
  source = 'model_semantic_intake',
  audit = null,
} = {}) {
  return {
    version: INDUSTRY_TAXONOMY_VERSION,
    id: def.id,
    label: def.label,
    domain: def.domain,
    confidence: Number(Math.max(0, Math.min(1, Number(confidence || 0))).toFixed(2)),
    evidence,
    alternatives: [],
    promptHints: [...def.promptHints],
    visualCues: [...def.visualCues],
    applicationContexts: [...def.applicationContexts],
    materialCues: [...def.materialCues],
    forbiddenCliches: [...def.forbiddenCliches],
    qaFocus: [...def.qaFocus],
    source,
    audit,
  };
}

function splitIndustryBrandText(value) {
  return Array.from(new Set(String(value || '')
    .split(/(?:[；;,，、/]+|\s+(?:和|及)\s+|(?:和|及)(?=[\u4e00-\u9fa5A-Za-z]))/g)
    .map((item) => normalizeText(item).replace(/[（(]\s*(?:可选小字|可选英文|英文小字|小字|可选)[^）)]{0,40}[）)]/gi, '').trim())
    .filter(Boolean)));
}

function hasExplicitMultiLogoIntent(subject = {}, rawBrandText = '') {
  const text = [
    subject.projectText,
    rawBrandText,
    subject.legalName,
    ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
  ].filter(Boolean).join('\n');
  return /(?:两个|两款|两家|多款|多个|多家|双|分别|各自|每个项目|项目一|项目二|一、|二、).{0,20}(?:LOGO|logo|标志|商标|品牌)|(?:LOGO|logo|标志|商标|品牌).{0,20}(?:两个|两款|两家|多款|多个|多家|分别|各自|每个项目)/.test(text);
}

function hasExplicitMultiLogoGeneralBusinessAllowance({ semanticIntake = {}, subject = {}, industryId = '', confidence = 0 } = {}) {
  if (industryId !== 'general_business_service') return false;
  if ((semanticIntake?.taskUnderstanding?.workflowId || '') !== 'logo_brand') return false;
  if (Number(confidence || 0) < 0.3) return false;
  const normalizedSubject = {
    ...semanticIntake?.subject,
    ...subject,
    mustUseText: [
      ...(Array.isArray(semanticIntake?.subject?.mustUseText) ? semanticIntake.subject.mustUseText : []),
      ...(Array.isArray(subject.mustUseText) ? subject.mustUseText : []),
    ],
  };
  const rawBrandText = normalizeText(semanticIntake?.modelResponse?.parsed?.subject?.brandText || semanticIntake?.subject?.brandText || subject.brandText || '');
  if (!hasExplicitMultiLogoIntent(normalizedSubject, rawBrandText)) return false;
  const rawBrands = splitIndustryBrandText(rawBrandText);
  if (rawBrands.length < 2) return false;
  const coverage = [
    normalizedSubject.projectText,
    normalizedSubject.brandText,
    normalizedSubject.productText,
    normalizedSubject.legalName,
    ...(normalizedSubject.mustUseText || []),
  ].filter(Boolean).join('\n');
  const compactCoverage = coverage.replace(/\s+/g, '');
  return rawBrands.every((brand) => {
    const compactBrand = brand.replace(/\s+/g, '');
    return coverage.includes(brand) || compactCoverage.includes(compactBrand);
  });
}

export function modelIndustrySpecFromSemanticIntake({ semanticIntake = {}, subject = {}, audit = null } = {}) {
  const taskUnderstanding = semanticIntake?.taskUnderstanding || {};
  let industryId = normalizeText(
    taskUnderstanding.industryId
      || semanticIntake?.subject?.industryId
      || subject.semanticIndustryId
      || subject.industryId
      || '',
  );
  const cue = taskUnderstanding.industryCue || subject.semanticIndustryCue || subject.industryText || null;
  const evidenceText = normalizeText([
    cue,
    ...(Array.isArray(taskUnderstanding.industryEvidence) ? taskUnderstanding.industryEvidence.map((item) => item.excerpt || item.quote || item.text || '') : []),
    ...(semanticIntake?.subject?.mustUseText || []),
    ...(subject.mustUseText || []),
  ].filter(Boolean).join('\n'));
  const industryOverrideEvidence = [];
  if (
    industryId === 'home_furniture_bedding'
    && KEEPSAKE_ILLUSTRATION_SIGNAL_RE.test(evidenceText)
    && !REAL_HOME_FURNITURE_SIGNAL_RE.test(evidenceText)
  ) {
    industryId = 'education_culture_media';
    industryOverrideEvidence.push({
      source: 'workflow-aware-model-industry-guard',
      signal: 'keepsake_illustration_over_home_furniture',
      excerpt: 'brief describes a cultural/生肖 illustration for a children hand/footprint keepsake frame, not furniture, bedding, mattress, or showroom design',
      weight: 160,
    });
  }
  if (
    industryId === 'pet_toy_character_product'
    && /摄影|拍摄|影像|相册|写真|快门|胶片|camera|photo|photography|studio/i.test(evidenceText)
    && !/宠物用品|宠物产品|玩具|毛绒|牵引|猫砂|零食|pet product|toy|plush/i.test(evidenceText)
  ) {
    industryId = 'general_business_service';
  }
  if (!industryId) {
    return {
      blocked: true,
      blockerType: 'model_industry_required',
      reason: 'model semantic intake did not return industryId; regex industry routing is disabled',
      source: 'model_semantic_intake',
      audit,
    };
  }
  const def = industryDefById(industryId);
  if (!def) {
    return {
      blocked: true,
      blockerType: 'model_industry_invalid',
      reason: 'model semantic intake returned unknown industryId: ' + industryId,
      industryId,
      source: 'model_semantic_intake',
      audit,
    };
  }
  const modelEvidence = Array.isArray(taskUnderstanding.industryEvidence)
    ? taskUnderstanding.industryEvidence.map((item) => ({
      source: 'model-semantic-intake/' + (item.source || 'industry'),
      signal: item.signal || 'model-industry',
      excerpt: item.excerpt || item.quote || item.text || taskUnderstanding.industryCue || subject.semanticIndustryCue || subject.industryText || null,
      weight: Number(item.weight || Math.round(Number(taskUnderstanding.industryConfidence || 0.5) * 100)),
    }))
    : [];
  if (cue && !modelEvidence.length) {
    modelEvidence.push({
      source: 'model-semantic-intake/industryCue',
      signal: 'model-industry-cue',
      excerpt: String(cue).slice(0, 220),
      weight: Math.round(Number(taskUnderstanding.industryConfidence || 0.5) * 100),
    });
  }
  modelEvidence.push(...industryOverrideEvidence);
  const hasPetSignal = /宠物|萌宠|猫|狗|犬|喵|汪|pet|cat|dog/i.test(evidenceText);
  const hasPhotographySignal = /摄影|拍摄|影像|相册|写真|快门|胶片|camera|photo|photography|studio/i.test(evidenceText);
  const petPhotographyService = industryId === 'general_business_service'
    && hasPetSignal
    && hasPhotographySignal;
	  if (petPhotographyService) {
	    modelEvidence.push({
	      source: 'model-semantic-intake/industryCue',
	      signal: 'pet_photography_service_cue_over_product_pack',
	      excerpt: 'semantic cue describes a pet photography service brand; avoid pet-toy/product packaging applications',
	      weight: 120,
	    });
	  }
	  const explicitMultiLogoGeneralBusinessAllowed = hasExplicitMultiLogoGeneralBusinessAllowance({
	    semanticIntake,
	    subject,
	    industryId,
	    confidence: taskUnderstanding.industryConfidence ?? semanticIntake?.subject?.industryConfidence ?? 0.5,
	  });
	  if (explicitMultiLogoGeneralBusinessAllowed) {
	    modelEvidence.push({
	      source: 'model-semantic-intake/industryCue',
	      signal: 'explicit_multilogo_general_business_allowed',
	      excerpt: 'buyer explicitly asks to combine/upgrade multiple supplied logos and all required brand names are preserved; general-business refpack is allowed despite low specific-industry confidence',
	      weight: 120,
	    });
	  }
	  const spec = specFromIndustryDef(def, {
	    confidence: taskUnderstanding.industryConfidence ?? semanticIntake?.subject?.industryConfidence ?? 0.5,
	    evidence: modelEvidence,
	    source: 'model_semantic_intake',
	    audit,
	  });
	  const allowedSpec = explicitMultiLogoGeneralBusinessAllowed
	    ? {
	        ...spec,
	        confidencePolicyOverride: {
	          allowBelowFloor: true,
	          code: 'explicit_multilogo_general_business_allowed',
	          minimumConfidence: 0.3,
	          reason: 'explicit multi-logo logo_brand brief preserves all required brand texts; keep general_business_service as a generic business-signage refpack with warning',
	        },
	      }
	    : spec;
	  if (petPhotographyService) {
	    return {
	      ...allowedSpec,
	      label: '通用商业 / 服务业（宠物摄影品牌）',
	      promptHints: [
	        'treat the brief as a pet photography service identity: camera/shutter/film plus cat/dog silhouette, warm studio trust, and refined service-brand applications',
        'show photography-service proof such as studio sign, photo album, appointment card, gallery/social avatar, watermark, or gift print packaging; do not turn it into pet toys or pet-product packaging',
      ],
      visualCues: ['camera shutter or aperture geometry', 'cat/dog silhouette or paw detail', 'photo album/gallery proof', 'warm studio service tone'],
      applicationContexts: ['photo studio sign', 'photo album cover', 'appointment card', 'gallery/social avatar', 'watermark on pet portrait'],
      materialCues: ['matte photo paper', 'album board', 'studio signage acrylic', 'soft neutral service stationery'],
      forbiddenCliches: ['pet toy package as the main application', 'chew toy or plush product proof', 'overly cartoon mascot', 'generic camera icon without pet signal'],
	      qaFocus: ['reads as pet photography service brand, not pet toy/product retail', 'English wordmark and icon work as a professional logo/VI system', 'camera/shutter/pet cues are simple, modern, and not over-decorated'],
	    };
	  }
	  return allowedSpec;
	}

// Regex industry scoring is retained for audit reports and explicit prompt-only
// replay fixtures. Production model-backed planning must use
// modelIndustrySpecFromSemanticIntake() instead.
export function classifyIndustry({ entry = {}, requirementText = '', subject = {}, workflowId = null } = {}) {
  const sourceFields = new Set(Array.isArray(subject.sourceFields) ? subject.sourceFields : []);
  const semanticIndustryCue = sanitizeIndustrySignalText(
    subject.semanticIndustryCue || (sourceFields.has('semantic-intake') ? subject.industryText : ''),
  );
  const text = normalizeText([
    entry.title,
    entry.category1Name,
    entry.category2Name,
    entry.category3Name,
    entry.industryName,
    entry.industry?.name,
    entry.industry?.id,
    subject.projectText,
    subject.brandText,
    subject.productText,
    subject.deliverableText,
    subject.industryText,
    ...(subject.mustUseText || []),
    requirementText,
  ].filter(Boolean).join('\n'));
  const industryText = sanitizeIndustrySignalText(text);
  const matches = [];
  for (const def of INDUSTRY_DEFS) {
    if (def.id === 'general_business_service') continue;
    const semanticEvidence = semanticIndustryCue
      ? evidenceFor(def, semanticIndustryCue).map((item) => ({
        ...item,
        source: 'semantic-intake/industryCue',
        weight: Math.max(160, Number(item.weight || 0)),
      }))
      : [];
    const evidence = [...semanticEvidence, ...evidenceFor(def, industryText)];
    if (!evidence.length) continue;
    matches.push({ def, evidence, score: evidence.reduce((sum, item) => sum + Number(item.weight || def.weight || 0), 0) });
  }
  const workflow = String(workflowId || '');
  const productDomainText = sanitizeIndustrySignalText([
    entry.title,
    subject.productText,
    subject.industryText,
    subject.semanticIndustryCue,
    semanticIndustryCue,
  ].filter(Boolean).join('\n'));
  const foodBeverage = matches.find((item) => item.def.id === 'food_beverage_restaurant');
  if (
    foodBeverage
    && (!workflow || workflow === 'logo_brand')
    && CONSUMABLE_FOOD_PACKAGING_SIGNAL_RE.test(productDomainText)
  ) {
    foodBeverage.score += 140;
    foodBeverage.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'food_brand_over_generic_manufacturing',
      excerpt: 'logo brief describes a consumable food/agricultural specialty brand; route through food/restaurant brand grammar before generic manufacturing cues from words like production/sales',
      weight: 140,
    });
  }
  if (
    foodBeverage
    && workflow === 'packaging_design'
    && CONSUMABLE_FOOD_PACKAGING_SIGNAL_RE.test(productDomainText)
  ) {
    foodBeverage.score += 220;
    foodBeverage.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'packaging_food_product_over_institutional_medical_background',
      excerpt: 'packaging brief product is a consumable food/gift item; institutional medical or research background should not route the pack to regulated medtech B2B',
      weight: 220,
    });
  }
  const spatial = matches.find((item) => item.def.id === 'spatial_retail_exhibition');
  if (spatial && /^(proposal_board|generic_design|presentation_deck)$/.test(workflow) && /展厅|展示区|空间|室内|前台|平面布局|动线|施工图|interior|exhibition/i.test(industryText)) {
    spatial.score += 120;
    spatial.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'spatial_proposal_workflow',
      excerpt: 'proposal/spatial workflow with exhibition/interior planning evidence',
      weight: 120,
    });
  }
  const homeImprovement = matches.find((item) => item.def.id === 'home_improvement_decoration');
  const propertyFacility = matches.find((item) => item.def.id === 'property_facility_real_estate_service');
  const financialInsurance = matches.find((item) => item.def.id === 'financial_insurance_service');
  const energyEv = matches.find((item) => item.def.id === 'energy_ev_infrastructure');
  const evElectricalComponents = matches.find((item) => item.def.id === 'ev_electrical_components_b2b');
  if (
    propertyFacility
    && financialInsurance
    && /物业|楼盘|楼宇|地产|房产|小区|园区|社区商业|商业管理|招商运营|property|real estate|facility/i.test(industryText)
  ) {
    propertyFacility.score += 120;
    propertyFacility.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'property_facility_context_over_finance_asset_management',
      excerpt: 'real-estate/facility context should route to property service even when asset-management wording appears',
      weight: 120,
    });
  }
  if (
    evElectricalComponents
    && (!workflow || workflow === 'logo_brand')
    && EV_ELECTRICAL_COMPONENT_SIGNAL_RE.test(industryText)
  ) {
    evElectricalComponents.score += 220;
    evElectricalComponents.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'ev_electrical_components_over_ev_infrastructure',
      excerpt: 'buyer describes EV electrical connection components such as busbar, terminals, connectors, or wiring parts; route to component-manufacturing B2B identity, not charging/swap station infrastructure',
      weight: 220,
    });
  }
  if (
    homeImprovement
    && energyEv
    && (!workflow || workflow === 'logo_brand' || /工业设计|产品设计|创品|居家小产品|五金工具|家用五金|结构方案|产品构想/i.test(industryText))
    && /电动车|摩托车|车灯|LED(?:灯|照明)?|新能源/i.test(industryText)
    && /未来可能涉及|逐步可能涉及|可能涉及|后续可能|家装照明/.test(industryText)
  ) {
    energyEv.score += 120;
    energyEv.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'core_ev_led_business_over_future_home_lighting_extension',
      excerpt: 'logo brief core business is EV/motorcycle LED lighting; home lighting is only a possible future extension',
      weight: 120,
    });
  }
  const industrialB2b = matches.find((item) => item.def.id === 'industrial_manufacturing_b2b');
  const medicalDevice = matches.find((item) => item.def.id === 'medical_device_healthcare_b2b');
  const generalBusiness = INDUSTRY_DEFS.find((item) => item.id === 'general_business_service');
  if (
    generalBusiness
    && workflow === 'packaging_design'
    && /圣诞|万圣节|派对|party|气球|balloon|节日|礼品|gift|彩盒|包装盒/i.test([semanticIndustryCue, productDomainText, industryText].filter(Boolean).join('\n'))
  ) {
    matches.push({
      def: generalBusiness,
      evidence: [{
        source: 'workflow-aware-industry-audit',
        signal: 'party_gift_packaging_over_unrelated_tech',
        excerpt: 'packaging brief describes party/gift/holiday goods such as Christmas, balloons, or gift boxes; route through general business packaging grammar instead of unrelated semiconductor/electronics cues',
        weight: 240,
      }],
      score: 240,
    });
  }
  if (
    generalBusiness
    && semanticIndustryCue
    && GENERAL_BUSINESS_SEMANTIC_CUE_RE.test(semanticIndustryCue)
  ) {
    matches.push({
      def: generalBusiness,
      evidence: [{
        source: 'semantic-intake/industryCue',
        signal: 'general_business_semantic_cue',
        excerpt: semanticIndustryCue,
        weight: 180,
      }],
      score: 180,
    });
  }
  if (
    medicalDevice
    && industrialB2b
    && (!workflow || workflow === 'logo_brand')
    && MEDICAL_DEVICE_SIGNAL_RE.test(industryText)
    && /生产|研发|制造|工厂|B2B|工业|设备|耗材|软件|系统|销售/i.test(industryText)
  ) {
    medicalDevice.score += 180;
    medicalDevice.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'medical_device_over_generic_manufacturing',
      excerpt: 'medical device / healthcare technology evidence should route to a regulated medtech B2B identity pack before generic industrial manufacturing',
      weight: 180,
    });
  }
  if (
    generalBusiness
    && /鲜花|花车|花店|花卉|花艺|花束|花香/.test(industryText)
    && !/新能源|换电|充电|电池|储能|光伏|风电|电站|电力|车灯|LED(?:灯|照明)?|EV\b|battery|charging/i.test(industryText)
  ) {
    matches.push({
      def: generalBusiness,
      evidence: [{
        source: 'workflow-aware-industry-audit',
        signal: 'flower_mobile_retail_over_ev_platform',
        excerpt: 'flower/mobile-cart retail evidence; electric vehicle is only the sales vehicle platform, not an energy infrastructure brief',
        weight: 130,
      }],
      score: 130,
    });
  }
  if (
    generalBusiness
    && (!workflow || workflow === 'logo_brand')
    && /(?:企业)?VI(?:设计)?|品牌视觉|形象背景墙|宣传彩页|小广告牌|统一形象服装标志|服装标志|统一形象名片|名片|400电话|客服热线|二维码|互联网企业|本地生活|爆品平台/i.test(industryText)
    && /背景墙|宣传彩页|广告牌|服装标志|名片|400电话|客服热线|二维码/.test(industryText)
  ) {
    matches.push({
      def: generalBusiness,
      evidence: [{
        source: 'workflow-aware-industry-audit',
        signal: 'business_vi_applications_over_landscape_keywords',
        excerpt: 'logo/VI brief lists corporate identity applications such as background wall, brochure, small billboard, apparel mark, business card, hotline, and QR; route as business/service VI instead of landscape/public-art proposal',
        weight: 260,
      }],
      score: 260,
    });
  }
  if (
    industrialB2b
    && (!workflow || workflow === 'logo_brand')
    && !MEDICAL_DEVICE_SIGNAL_RE.test(industryText)
    && /生产|研发|制造|工厂|B2B|工业/i.test(industryText)
    && /电动车|摩托车|车灯|LED(?:灯|照明)?|设备|机械/i.test(industryText)
  ) {
    industrialB2b.score += 140;
    industrialB2b.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'manufacturing_core_business_over_future_extension',
      excerpt: 'logo brief describes production/R&D/sales for vehicle lighting or industrial hardware; route as B2B manufacturing identity',
      weight: 140,
    });
  }
  const sportsOutdoor = matches.find((item) => item.def.id === 'sports_fitness_outdoor');
  if (
    industrialB2b
    && sportsOutdoor
    && /工业设计|产品设计|创品|居家小产品|五金工具|家用五金|结构方案|产品构想/i.test(industryText)
    && /居家健身|健身产品|户外/.test(industryText)
  ) {
    industrialB2b.score += 150;
    industrialB2b.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'industrial_design_company_over_minor_sports_product_line',
      excerpt: 'logo brief describes an industrial/product design company; fitness/outdoor is only one product-line example',
      weight: 150,
    });
  }
  const fashionAccessories = matches.find((item) => item.def.id === 'fashion_apparel_accessories');
  if (
    fashionAccessories
    && workflow === 'catalog_brochure'
    && /产品清册|产品画册|包装盒|首饰盒|饰品盒|礼品盒|高档珠宝画册|珠宝|首饰|饰品/.test(industryText)
  ) {
    fashionAccessories.score += 130;
    fashionAccessories.evidence.push({
      source: 'workflow-aware-industry-audit',
      signal: 'catalog_brochure_accessory_packaging_over_spatial_display',
      excerpt: 'catalog/brochure brief describes jewelry/accessory packaging product catalog; product display wording is brochure context, not spatial retail design',
      weight: 130,
    });
  }
  const rankedMatches = mergeDuplicateMatches(matches).sort((a, b) => b.score - a.score);
  const selected = rankedMatches[0] || {
    def: INDUSTRY_DEFS.find((item) => item.id === 'general_business_service'),
    evidence: semanticIndustryCue
      ? [{
        source: 'semantic-intake/industryCue',
        signal: 'general_business_unmapped_semantic_cue',
        excerpt: semanticIndustryCue,
        weight: 40,
      }]
      : [{
        source: 'fallback',
        signal: 'no strong industry keyword matched',
        excerpt: [entry.title, entry.category3Name].filter(Boolean).join(' / ') || null,
        weight: 20,
      }],
    score: semanticIndustryCue ? 40 : 20,
  };
  const second = rankedMatches.find((item) => item.def.id !== selected.def.id);
  const confidence = rankedMatches.length ? Math.min(0.96, 0.58 + (selected.score - Number(second?.score || 0)) / 120) : 0.36;
  return {
    version: INDUSTRY_TAXONOMY_VERSION,
    id: selected.def.id,
    label: selected.def.label,
    domain: selected.def.domain,
    confidence: Number(confidence.toFixed(2)),
    evidence: selected.evidence.map((item) => ({ ...item, excerpt: item.excerpt ? item.excerpt.slice(0, 220) : null })),
    alternatives: rankedMatches.filter((item) => item.def.id !== selected.def.id).slice(0, 4).map((item) => ({ id: item.def.id, label: item.def.label, domain: item.def.domain, score: item.score })),
    promptHints: [...selected.def.promptHints],
    visualCues: [...selected.def.visualCues],
    applicationContexts: [...selected.def.applicationContexts],
    materialCues: [...selected.def.materialCues],
    forbiddenCliches: [...selected.def.forbiddenCliches],
    qaFocus: [...selected.def.qaFocus],
  };
}

export function listIndustries() {
  return INDUSTRY_DEFS.map((item) => ({ id: item.id, label: item.label, domain: item.domain }));
}

export function industryTaxonomyContractsSelftest() {
  const industries = listIndustries();
  const medical = classifyIndustry({
    entry: { title: '医疗器械企业LOGO设计', category3Name: 'LOGO设计' },
    requirementText: '医疗器械、临床设备、诊断软件品牌升级，需要B2B可信赖应用。',
    subject: { industryCue: '医疗器械 / 临床设备 / 诊断软件' },
    workflowId: 'logo_brand',
  });
  const semantic = modelIndustrySpecFromSemanticIntake({
    semanticIntake: {
      taskUnderstanding: {
        workflowId: 'logo_brand',
        industryId: 'ai_research_software_b2b',
        industryCue: 'AI research software',
        industryConfidence: 0.9,
        industryEvidence: [{ source: 'requirement', quote: 'AI research software platform' }],
      },
      subject: { mustUseText: ['AI research software platform'] },
    },
    subject: {},
  });
  const bad = modelIndustrySpecFromSemanticIntake({
    semanticIntake: { taskUnderstanding: { industryId: 'unknown_industry' } },
  });
  const ok = industries.length >= 20
    && medical.id === 'medical_device_healthcare_b2b'
    && semantic.id === 'ai_research_software_b2b'
    && bad.blocked === true
    && bad.blockerType === 'model_industry_invalid';
  return { ok, industryCount: industries.length, medical, semantic, bad };
}
